// 依赖方向检查（门禁 G7 / 文档 20 §3.2）。
// 规则：① 禁止深层导入（@lcode/x/src/*）；② 接口包不得依赖实现/消费包；③ 骨架层不得出现具体实现包名。
//
// 三类豁免（各有文档依据，不是放水）：
// - **装配层**（`packages/api/*`）：docs/24 T4.1 明示"骨架层不能依赖实现包、接口包不能含实现
//   → 集束与实现之间必须有一个装配层"。这批包的天职就是把实现装到一起，依赖实现包是其职责。
// - **测试文件**（`*.test.ts`）：夹具下探到实现包（`ReplayLlmAdapter` 等）是测试需要，
//   不代表产品代码的依赖方向。
// - **bundle 集束**（`lcode-*`）：同装配层定位，已在 IMPL_LIKE 名单。
//
// 注意：本脚本要同时兼容 `packages/<包>/src` 与 `packages/<组>/<包>/src` 两种目录布局。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const PACKAGES = join(ROOT, 'packages')

// 实现/消费包特征：接口包之外的所有包名（tool-*、*-local、具体供应商等）
const IMPL_LIKE = [
  /^tool-/,
  /-local$/,
  /-sandbox$/,
  /-pty$/,
  /-jsonl$/,
  /-sqlite$/,
  /-file$/,
  /-stdio$/,
  /-replay$/,
  /-prune$/,
  /-summary$/,
  /-deepseek$/,
  /-anthropic$/,
  /-openai$/,
  /-ollama$/,
  /-gateway$/,
  /web-fetch/,
  /web-search/,
  /spill-local/,
  /skill-filesystem/,
  /subagent-inprocess/,
  /jobs-local/,
  /agent-presets/,
  /plugin-/,
  /^lcode-(base|desktop)$/,
  /^commands$/,
  /^user-questions$/,
  /^permission-presets$/,
  /^plan-mode$/,
  /^context-/,
  /^file-reference$/,
  /^session-reference$/,
]

/** 装配层：允许依赖实现包（docs/24 T4.1 的边界层决策："集束与实现之间必须有一个装配层"） */
const ASSEMBLY_LIKE = /-api$/

/** 测试文件：夹具依赖下探不算架构方向违规（含 .e2e.test.ts / .replay.test.ts） */
const TEST_FILE = /\.test\.(ts|tsx)$/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** 枚举全部包（兼容一层与两层目录布局） */
function listPackages() {
  const out = []
  for (const name of readdirSync(PACKAGES)) {
    const entry = join(PACKAGES, name)
    if (!statSync(entry).isDirectory()) continue
    if (existsSync(join(entry, 'src'))) {
      out.push({ name, dir: entry })
      continue
    }
    for (const sub of readdirSync(entry)) {
      const pkgDir = join(entry, sub)
      if (statSync(pkgDir).isDirectory() && existsSync(join(pkgDir, 'src'))) {
        out.push({ name: sub, dir: pkgDir })
      }
    }
  }
  return out
}

let errors = 0
for (const { name: pkgName, dir: pkgPath } of listPackages()) {
  const isAssembly = ASSEMBLY_LIKE.test(pkgName)
  const isInterfacePkg = !IMPL_LIKE.some((re) => re.test(pkgName)) && !isAssembly
  for (const file of walk(join(pkgPath, 'src'))) {
    if (TEST_FILE.test(file)) continue
    const content = readFileSync(file, 'utf8')
    for (const m of content.matchAll(/from\s+['"](@lcode\/[^'"]+)['"]/g)) {
      const target = m[1]
      const targetName = target.replace('@lcode/', '')
      // 规则①：深层导入
      if (target.includes('/src/')) {
        console.error(`✗ 深层导入 ${file}: ${target}（必须用包名）`)
        errors++
        continue
      }
      // 规则②：接口包不得依赖实现/消费包（装配层与测试豁免，见文件头）
      if (isInterfacePkg && IMPL_LIKE.some((re) => re.test(targetName)) && targetName !== pkgName) {
        console.error(`✗ 接口包 ${pkgName} 依赖实现包 ${target}（应依赖接口，20 §3.1）`)
        errors++
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n依赖方向检查失败：${errors} 处违规`)
  process.exit(1)
}
console.log(`✓ 依赖方向检查通过（装配层 ${ASSEMBLY_LIKE.source} 与测试文件已豁免，见 docs/24 T4.1）`)
