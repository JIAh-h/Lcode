/// <reference path="./js-yaml.d.ts" />

import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import type { PresetCatalogEntry, PresetService } from '@lcode/preset'
import { ERROR_CODES, LcodeErrorImpl, isJsonValue, type JsonValue } from '@lcode/util'

export interface PresetRoot { readonly path: string; readonly source: PresetCatalogEntry['source'] }
export interface LocalAgentPresetsOptions { readonly roots: readonly PresetRoot[] }
export interface PresetSnapshot { readonly sessionId: string; readonly ids: readonly string[]; readonly config: JsonValue; readonly sources: readonly PresetCatalogEntry['source'][] }
interface FoundPreset extends PresetCatalogEntry { readonly path: string }

/** Declarative preset provider. Loading is data-only and never activates plugins. */
export class LocalAgentPresets implements PresetService {
  constructor(private readonly options: LocalAgentPresetsOptions) {}
  async list(): Promise<readonly PresetCatalogEntry[]> { return (await this.scan()).map(({ path: _path, ...entry }) => entry) }
  async load(id: string): Promise<{ readonly config: string; readonly path: string; readonly source: PresetCatalogEntry['source'] } | undefined> {
    const entry = (await this.scan()).find((candidate) => candidate.id === id)
    return entry === undefined ? undefined : { config: await readFile(entry.path, 'utf8'), path: entry.path, source: entry.source }
  }
  async snapshot(sessionId: string, ids: readonly string[]): Promise<PresetSnapshot> {
    const config: Record<string, JsonValue> = {}; const sources: PresetCatalogEntry['source'][] = []
    for (const id of ids) {
      const entry = (await this.scan()).find((candidate) => candidate.id === id)
      if (entry === undefined) throw presetError(`找不到预设：${id}`, ERROR_CODES.EC_NOT_FOUND)
      const parsed = load(await readFile(entry.path, 'utf8'))
      if (!isRecord(parsed) || !isJsonValue(parsed)) throw presetError(`预设必须是纯数据对象：${id}`, ERROR_CODES.EC_VALIDATION_FAILED)
      rejectSecrets(parsed, id)
      const { id: _id, name: _name, ...patch } = parsed
      mergePatch(config, patch)
      sources.push(entry.source)
    }
    return { sessionId, ids: [...ids], config, sources }
  }
  export(snapshot: PresetSnapshot): string { return dump(snapshot.config, { sortKeys: true, noRefs: true, lineWidth: 120 }) }
  private async scan(): Promise<FoundPreset[]> {
    const result: FoundPreset[] = []; const known = new Set<string>()
    for (const root of this.options.roots) {
      let entries
      try { entries = await readdir(resolve(root.path), { withFileTypes: true }) } catch (error) { if (isMissing(error)) continue; throw presetError(`无法读取预设目录：${root.path}`, ERROR_CODES.EC_VALIDATION_FAILED) }
      for (const entry of entries) {
        if (!entry.isFile() || (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml'))) continue
        const path = join(resolve(root.path), entry.name); const info = await lstat(path)
        if (info.isSymbolicLink()) continue
        const text = await readFile(path, 'utf8'); const parsed = load(text)
        if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') continue
        if (known.has(parsed.id)) continue
        result.push({ id: parsed.id, name: parsed.name, source: root.source, path }); known.add(parsed.id)
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id))
  }
}
export function createLocalAgentPresets(options: LocalAgentPresetsOptions): LocalAgentPresets { return new LocalAgentPresets(options) }

/** Patch semantics: objects merge recursively, arrays/scalars replace wholesale. */
function mergePatch(target: Record<string, JsonValue>, patch: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key]
    if (isRecord(current) && isRecord(value)) mergePatch(current, value)
    else target[key] = value
  }
}
function rejectSecrets(value: JsonValue, id: string, path = ''): void {
  if (Array.isArray(value)) { value.forEach((item, index) => rejectSecrets(item, id, `${path}[${index}]`)); return }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const next = path === '' ? key : `${path}.${key}`
    if (/^(api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|token)$/i.test(key)) throw presetError(`预设 ${id} 含敏感字段：${next}`, ERROR_CODES.EC_VALIDATION_FAILED)
    rejectSecrets(child, id, next)
  }
}
function isRecord(value: unknown): value is Record<string, JsonValue> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT' }
function presetError(message: string, code: typeof ERROR_CODES.EC_NOT_FOUND | typeof ERROR_CODES.EC_VALIDATION_FAILED): LcodeErrorImpl { return new LcodeErrorImpl({ code, message, userMessage: '这个预设无法安全使用。', retryable: false }) }
