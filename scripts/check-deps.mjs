// 依赖方向检查（门禁 G7 / 文档 20 §3.2）。
// 规则：① 禁止深层导入（@lcode/x/src/*）；② 接口包不得依赖实现/消费包；③ 骨架层不得出现具体实现包名。
// 骨架版为轻量扫描；完整规则随包数量增长在 CI 细化。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

let errors = 0
for (const pkgDir of readdirSync(PACKAGES)) {
  const groupDir = join(PACKAGES, pkgDir)
  if (!statSync(groupDir).isDirectory()) continue
  for (const pkgName of readdirSync(groupDir)) {
    const pkgPath = join(groupDir, pkgName)
    if (!statSync(pkgPath).isDirectory()) continue
    const isInterfacePkg = !IMPL_LIKE.some((re) => re.test(pkgName))
    for (const file of walk(join(pkgPath, 'src'))) {
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
        // 规则②：接口包不得依赖实现/消费包
        if (isInterfacePkg && IMPL_LIKE.some((re) => re.test(targetName)) && targetName !== pkgName) {
          console.error(`✗ 接口包 ${pkgName} 依赖实现包 ${target}（应依赖接口，20 §3.1）`)
          errors++
        }
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n依赖方向检查失败：${errors} 处违规`)
  process.exit(1)
}
console.log('✓ 依赖方向检查通过')
