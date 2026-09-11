// 七条不变量检查（门禁 G6 / 文档 15 §2）。
// 骨架版实现 I6（核心循环无业务分支：AST 级扫描 agent-loop 源码关键词黑名单）；
// I1–I5 由单测与快照重放守护，I7 由日志脱敏 golden test 守护（批次⑧）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const AGENT_LOOP = join(ROOT, 'packages/core/agent-loop/src')

// I6 黑名单：出现即代表"循环里做了针对具体能力的判断"（产品宪法第三条）
const I6_BLACKLIST = [
  'needsApproval',
  'approval',
  'tokens >',
  'tokenLimit',
  'contextWindow',
  'rateLimit',
  'maxSteps',
  'needsCompaction',
  'isSandboxed',
  'outsideWorkspace',
  'requiresPermission',
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

let failed = false
for (const file of walk(AGENT_LOOP)) {
  const content = readFileSync(file, 'utf8')
  for (const word of I6_BLACKLIST) {
    // 粗扫（注释/字符串会被误伤——正式版换 AST 解析 + 白名单，见 23 未决问题）
    if (content.includes(word)) {
      console.error(`✗ I6 违规：${file} 出现关键词「${word}」（循环内不得针对具体能力做判断）`)
      failed = true
    }
  }
}

if (failed) {
  process.exit(1)
}
console.log('✓ 不变量检查通过（I6；I1–I5/I7 由测试守护）')
