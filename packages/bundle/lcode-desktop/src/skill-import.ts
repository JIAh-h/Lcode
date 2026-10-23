import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

export interface ImportedSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: 'user'
}

interface SkillDocument {
  readonly name: string
  readonly description: string
}

const MAX_SKILL_BYTES = 128 * 1024
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_EXTRACT_BYTES = 4 * 1024 * 1024
const MAX_FILES = 64

/** 从用户选择的 `.md` 或 `.zip` 安装到 `~/.lcode/skills/<id>`，返回新技能信息。 */
export function importSkill(input: { readonly home: string; readonly path: string }): ImportedSkill {
  const lower = input.path.toLowerCase()
  if (lower.endsWith('.zip')) return importZip(input.home, input.path)
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return importMarkdown(input.home, input.path)
  throw new Error('只支持导入 SKILL.md 或 .zip 技能包')
}

/**
 * 把随应用分发的内置技能补到用户技能目录。
 *
 * 只补缺失项：用户改过同名技能时不覆盖。运行时的技能目录仍把内置根放在
 * 用户根之前，所以即使这个副本被删掉，内置技能也还在；下次启动会再补回来。
 */
export function seedBuiltinSkills(input: { readonly home: string; readonly sourceDir: string }): void {
  let entries
  try {
    entries = readdirSync(input.sourceDir, { withFileTypes: true })
  } catch {
    return
  }
  const root = resolve(input.home, 'skills')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = resolve(input.sourceDir, entry.name)
    if (!existsSync(resolve(source, 'SKILL.md'))) continue
    const target = resolve(root, entry.name)
    if (existsSync(resolve(target, 'SKILL.md'))) continue
    cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
  }
}

export function removeUserSkill(input: { readonly home: string; readonly id: string }): void {
  const root = resolve(input.home, 'skills')
  const target = resolve(root, input.id)
  if (input.id.trim() === '' || target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error('技能 id 非法')
  }
  const info = lstatSync(target)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('只能删除用户目录下的技能')
  rmSync(target, { recursive: true, force: true })
}

function importMarkdown(home: string, path: string): ImportedSkill {
  const bytes = readFileSync(path)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_BYTES) throw new Error('SKILL.md 为空或超过 128KB')
  const text = bytes.toString('utf8')
  const document = describeSkill(text, basename(path, '.md'))
  const slug = uniqueSlug(home, slugify(document.name))
  writeFiles(home, slug, new Map([['SKILL.md', bytes]]))
  return { id: slug, ...document, source: 'user' }
}

function importZip(home: string, path: string): ImportedSkill {
  const archive = readFileSync(path)
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('技能压缩包为空或超过 10MB')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(archive))
  } catch {
    throw new Error('无法解压这个 zip 文件')
  }
  const files = new Map<string, Uint8Array>()
  for (const [rawName, data] of Object.entries(entries)) {
    const name = normalizeEntry(rawName)
    if (name === undefined) throw new Error('压缩包包含不安全的路径')
    if (name.endsWith('/')) continue
    if (name === '.DS_Store' || name.startsWith('__MACOSX/')) continue
    files.set(name, data)
  }
  const manifests = [...files.keys()].filter((name) => basename(name) === 'SKILL.md')
  if (manifests.length === 0) throw new Error('压缩包里没有 SKILL.md')
  if (manifests.length > 1) throw new Error('一个压缩包只能包含一个技能')
  const manifest = manifests[0]!
  const prefix = dirname(manifest) === '.' ? '' : `${dirname(manifest)}/`
  const selected = [...files.entries()].filter(([name]) => prefix === '' || name.startsWith(prefix))
  if (selected.length > MAX_FILES) throw new Error(`技能文件过多（最多 ${MAX_FILES} 个）`)
  let total = 0
  for (const [, data] of selected) total += data.byteLength
  if (total > MAX_EXTRACT_BYTES) throw new Error('技能解压后超过 4MB')
  const manifestBytes = files.get(manifest)!
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_SKILL_BYTES) throw new Error('SKILL.md 为空或超过 128KB')
  const document = describeSkill(strFromU8(manifestBytes), basename(prefix === '' ? path : prefix.slice(0, -1)))
  const slug = uniqueSlug(home, slugify(document.name))
  const output = new Map<string, Uint8Array>()
  for (const [name, data] of selected) output.set(name.slice(prefix.length), data)
  writeFiles(home, slug, output)
  return { id: slug, ...document, source: 'user' }
}

function normalizeEntry(raw: string): string | undefined {
  const name = raw.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (name === '' || name.startsWith('/') || /^[A-Za-z]:\//.test(name)) return undefined
  if (name.split('/').some((segment) => segment === '..')) return undefined
  return name
}

function writeFiles(home: string, slug: string, files: ReadonlyMap<string, Uint8Array>): void {
  const root = resolve(home, 'skills', slug)
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const [relative, data] of files) {
      const target = resolve(root, relative)
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('技能文件路径非法')
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, data, { mode: 0o600 })
    }
  } catch (error) {
    // 失败不留半装目录，否则下次同名导入会被错误地判成冲突
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function describeSkill(text: string, fallback: string): SkillDocument {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? ''
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || fallback
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || text.split(/\r?\n/).find((line) => line.trim() !== '' && !line.startsWith('#'))?.trim() || name
  return { name, description }
}

function slugify(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '')
  if (ascii !== '' && /[a-z0-9]/.test(ascii)) return ascii.slice(0, 40)
  return `skill-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`
}

function uniqueSlug(home: string, base: string): string {
  for (let index = 1; index < 100; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`
    try {
      lstatSync(resolve(home, 'skills', candidate))
    } catch {
      return candidate
    }
  }
  throw new Error('无法生成唯一的技能目录名')
}
