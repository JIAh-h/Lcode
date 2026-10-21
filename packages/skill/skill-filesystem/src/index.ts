import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { SkillCatalogEntry, SkillService } from '@lcode/skill'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

const MAX_SKILL_BYTES = 128 * 1024
export interface SkillRoot { readonly path: string; readonly source: SkillCatalogEntry['source'] }
export interface LocalSkillFilesystemOptions { readonly roots: readonly SkillRoot[] }
interface FoundSkill extends SkillCatalogEntry { readonly path: string }

/** Read-only two-phase SKILL.md provider. It never discovers or runs scripts. */
export class LocalSkillFilesystem implements SkillService {
  constructor(private readonly options: LocalSkillFilesystemOptions) {}
  async catalog(): Promise<readonly SkillCatalogEntry[]> { return (await this.scan()).map(({ path: _path, ...entry }) => entry) }
  async load(id: string): Promise<{ readonly instructions: string; readonly path: string } | undefined> {
    const found = (await this.scan()).find((entry) => entry.id === id)
    if (found === undefined) return undefined
    const info = await lstat(found.path)
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SKILL_BYTES) throw invalidSkill(`技能文件不可安全读取：${id}`)
    return { instructions: await readFile(found.path, 'utf8'), path: found.path }
  }
  private async scan(): Promise<FoundSkill[]> {
    const found: FoundSkill[] = []; const known = new Set<string>()
    for (const root of this.options.roots) { const path = resolve(root.path); await walk(path, path, root.source, found, known) }
    return found.sort((left, right) => left.id.localeCompare(right.id))
  }
}
export function createLocalSkillFilesystem(options: LocalSkillFilesystemOptions): SkillService { return new LocalSkillFilesystem(options) }
async function walk(root: string, directory: string, source: SkillCatalogEntry['source'], found: FoundSkill[], known: Set<string>): Promise<void> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (directory === root && isMissing(error)) return; throw invalidSkill(`无法读取技能目录：${directory}`) }
  for (const entry of entries) {
    const path = join(directory, entry.name); const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) await walk(root, path, source, found, known)
    if (!info.isFile() || entry.name !== 'SKILL.md' || info.size > MAX_SKILL_BYTES) continue
    const id = relative(root, directory).replaceAll('\\', '/')
    if (id === '' || id.startsWith('../') || known.has(id)) continue
    const text = await readFile(path, 'utf8'); found.push({ id, source, path, ...describe(text, basename(directory)) }); known.add(id)
  }
}
function describe(text: string, fallback: string): Pick<SkillCatalogEntry, 'name' | 'description'> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? ''
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || fallback
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || text.split(/\r?\n/).find((line) => line.trim() !== '' && !line.startsWith('#'))?.trim() || name
  return { name, description }
}
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT' }
function invalidSkill(message: string): LcodeErrorImpl { return new LcodeErrorImpl({ code: ERROR_CODES.EC_VALIDATION_FAILED, message, userMessage: '这个技能文件无法安全加载。', retryable: false }) }
