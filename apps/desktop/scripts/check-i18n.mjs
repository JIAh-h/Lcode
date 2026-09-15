/**
 * i18n 覆盖率校验。
 *
 * 用法：node scripts/check-i18n.mjs
 *
 * 做两件事：
 * 1. 扫描 renderer 下所有源码里出现的中文串，找出**没进词典**的（漏译）；
 * 2. 找出词典里**源码已不再引用**的条目（僵尸条目）。
 *
 * 为什么用「扫全部中文串」而不是「只扫 t('…')」：Seg / Select / ChipGroup /
 * PopMenu 的选项文案是在**组件内部**翻译的（调用方传中文原文、值也保持原文），
 * 源码里没有 `t()` 包裹，只看 `t()` 会漏掉一大片。
 *
 * 扫描结果里的“数据字符串”（会话标题、mock 内容、文件路径）本就该保持中文，
 * 已列入下方 DATA_OK 白名单。
 *
 * 词典以纯文本解析（不 import .ts），因此脚本可直接用 node 跑，无需构建。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(ROOT, 'renderer')
const DICT_FILE = join(RENDERER, 'i18n', 'en-US.ts')

/** 本就该保持中文的串：会话标题、mock 内容、示例代码、开发日志等（非界面文案） */
const DATA_OK = new Set([
  '把 parse.ts 换成结构化解析',
  '把 utils/parse.ts 里的手写 JSON 解析换成结构化解析，并补一个测试。',
  'web-app / 把 parse.ts 换成结构化解析',
  '[user] 把 parse.ts 换成结构化解析',
  '读取 src/parse.ts',
  '搜索所有调用点',
  '改写为结构化解析',
  '中文（简体）',
  '　',
  '看一下这个项目主要是做什么的',
  '给订单接口补测试',
  '修登录态过期不跳转',
  '[Lcode] 界面渲染出错：',
])

/** 含中文即为待翻译候选：汉字 + 中文标点（、。「」等） */
const CJK = /[\u4e00-\u9fa5\u3000-\u303f]/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** 去注释。先把 `://` 占位，否则 `https://…` 会被当成行注释截断 */
function stripComments(src) {
  return src
    .replace(/:\/\//g, '\u0001')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\u0001/g, '://')
}

/** 源码里出现的所有中文串（含 JSX 文本与字符串字面量） */
function collectStrings(src) {
  const found = new Set()
  for (const m of src.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n]*)`/g)) {
    const v = m[1] ?? m[2] ?? m[3]
    // 含 ${…} 的是拼接模板，不是可翻译的整串
    if (v && CJK.test(v) && !v.includes('${')) found.add(v)
  }
  /*
   * **模板字面量里嵌套的字符串**要单独再扫一遍。
   *
   * 上面那条正则把整个反引号串匹配掉了，于是 `` `${x ? t('甲') : t('乙')} ▾` ``
   * 里的 '甲' / '乙' 根本不会被采集——结果是：源码明明在用，脚本却报"僵尸条目"
   * （实测踩过：`选择模型` 被误报）。
   *
   * 修法：把每个 `${…}` 的**内容**抽出来，再扫里面的引号串。
   */
  for (const m of src.matchAll(/\$\{([^{}]*)\}/g)) {
    for (const inner of (m[1] ?? '').matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"'/g)) {
      const v = inner[1] ?? inner[2]
      if (v && CJK.test(v)) found.add(v)
    }
  }
  for (const m of src.matchAll(/>([^<>{}]*[\u4e00-\u9fa5\u3000-\u303f][^<>{}]*)</g)) {
    const v = m[1].trim()
    if (v) found.add(v)
  }
  return found
}

/** 从词典源码里取出键（支持裸键与引号键） */
function readDictKeys(src) {
  const body = stripComments(src)
  const keys = []
  for (const m of body.matchAll(
    /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5.]*))\s*:/gm,
  )) {
    const raw = m[1] ?? m[2] ?? m[3]
    if (raw) keys.push(m[1] !== undefined || m[2] !== undefined ? raw.replace(/\\(.)/g, '$1') : raw)
  }
  return keys
}

const dictKeys = readDictKeys(readFileSync(DICT_FILE, 'utf8'))
const dictSet = new Set(dictKeys)
const dups = dictKeys.filter((k, i) => dictKeys.indexOf(k) !== i)

const files = walk(RENDERER).filter((f) => f !== DICT_FILE)
const usedKeys = new Set()
const missing = []
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  for (const s of collectStrings(src)) {
    if (dictSet.has(s)) {
      usedKeys.add(s)
      continue
    }
    if (DATA_OK.has(s)) continue
    missing.push(`${rel}  «${s}»`)
  }
}

const unused = dictKeys.filter((k) => !usedKeys.has(k))

console.log(`词典条目 ${dictKeys.length} · 已覆盖 ${usedKeys.size}`)
if (dups.length) {
  console.log(`\n[重复键] ${dups.length} 条：`)
  for (const d of new Set(dups)) console.log('  ' + d)
}
console.log(missing.length ? `\n[漏译] ${missing.length} 条：` : '\n[漏译] 无')
for (const m of missing) console.log('  ' + m)
console.log(unused.length ? `\n[僵尸条目] ${unused.length} 条：` : '\n[僵尸条目] 无')
for (const u of unused) console.log('  ' + u)
process.exitCode = missing.length || dups.length ? 1 : 0
