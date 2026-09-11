// 包体积基线（门禁 G10 / 23 §11：记录基线，超阈值 +10% 报警）
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|json|css)$/.test(name)) out.push(p)
  }
  return out
}

let total = 0
for (const dir of ['packages', 'apps']) {
  const base = join(ROOT, dir)
  if (!statSync(base).isDirectory()) continue
  for (const file of walk(base)) {
    total += statSync(file).size
  }
}

console.log(`源码体积基线：${(total / 1024).toFixed(1)} KB（骨架阶段参考值）`)
