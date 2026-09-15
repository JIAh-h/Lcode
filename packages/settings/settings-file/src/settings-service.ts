import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfigLayer, SettingValue, SettingsService } from '@lcode/settings'
import { openIndexDb } from '@lcode/session-persistence-sqlite'
import type { JsonValue } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl, normalizePath, nowEpochMs } from '@lcode/util'
import { writeFileAtomicSync } from '@lcode/util/fs-atomic'
import {
  CONFIG_LAYER_BY_ID,
  LAYER_ORDER,
  SCOPE_BY_LAYER,
  type FieldDescriptor,
  type LayerId,
  type ResolveScope,
  type SettingsApi,
  type SettingsChange,
  type SettingsGetInput,
  type SettingsGetResult,
  type SettingsScope,
  type SettingsUpdateInput,
  type SettingsUpdateResult,
} from './types.ts'

/**
 * settings 的六层合并实现（doc 18 §2；实施计划 T4.2）。
 *
 * ## 层与存放位置（doc 18 §2.1 的权威定义）
 *
 * | 层 | 存放 | 谁改 |
 * |---|---|---|
 * | L1 单次覆盖 | **内存**（`setOverride`） | 程序化调用方 / CLI 参数 |
 * | L2 会话选择 | `settings_kv`（`scope='session'`） | 用户（会话内切换器） |
 * | L3 工作区预设 | `settings_kv`（`scope='workspace'`） | 用户 / 团队共享 |
 * | L4 用户设置 | **`settings.json`（真相）** + `settings_kv`（投影） | 用户 |
 * | L5 适配器基座 | **内存**（`registerAdapterBase`，由适配器 `apply()` 注册） | 插件作者 |
 * | L6 schema 默认 | **代码**（字段描述符的 `default`） | 开发者 |
 *
 * **两条不可混用的语义**（doc 18 §2.2 D-2）：本服务是**逐字段合并**，
 * 浅层只覆盖它显式写过的键；L4 写了 `baseUrl` 不会把 L5 的 `models` 清单抹掉。
 * 这与插件装配的「patch 替换整段 config」是两回事，别混用。
 *
 * ## 为什么 L4 同时有文件与表
 *
 * 22 §2.2 要求数据**可 grep、可导出**，所以用户层以 `settings.json` 为真相；
 * `settings_kv` 是它的可查询投影（22 §3.9），也是 L2/L3 的唯一存放处。
 * 打开时把文件灌进表，写入时两边一起更新——单向：文件 → 表。
 *
 * ## 为什么依赖 `@lcode/session-persistence-sqlite`
 *
 * `settings_kv` 按 doc 22 §3 就在**同一个 `index.db`** 里（那是全部 15 张表的归属）。
 * 因此本包必须走 `openIndexDb()` 才能保证 pragma 与迁移就绪。
 * 后续若把「连接 + DDL 的 owner」抽成中立包，这里应改成依赖那个包（已记在 docs/24 未决项）。
 */

export interface LocalSettingsOptions {
  readonly home: string
  /** 注入连接（测试用）。类型取自 `openIndexDb` 的返回，避免本包额外依赖 `better-sqlite3` 的类型 */
  readonly db?: SettingsDb | undefined
  readonly now?: (() => number) | undefined
}

export type SettingsDb = ReturnType<typeof openIndexDb>

interface Entry {
  readonly namespace: string
  readonly key: string
  readonly value: JsonValue
  readonly layer: 'L2' | 'L3' | 'L4'
  readonly scope: SettingsScope
  readonly scopeRef: string
}

function notFound(namespace: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_FOUND,
    message: `未知的设置命名空间：${namespace}`,
    userMessage: '没找到这个设置项。',
    retryable: false,
  })
}

function validationFailed(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_VALIDATION_FAILED,
    message,
    userMessage: '这个值不符合要求，请检查后再保存。',
    retryable: false,
  })
}

function key(entry: Pick<Entry, 'namespace' | 'key' | 'layer' | 'scope' | 'scopeRef'>): string {
  return `${entry.namespace}\u0000${entry.key}\u0000${entry.layer}\u0000${entry.scope}\u0000${entry.scopeRef}`
}

/** 把 `a.b.c` 写进嵌套对象（settings.json 的形态） */
function setPath(target: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const segments = path.split('.')
  let node = target
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!
    const existing = node[segment]
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      node[segment] = {} as JsonValue
    }
    node = node[segment] as Record<string, JsonValue>
  }
  node[segments[segments.length - 1]!] = value
}

export class LocalSettingsService implements SettingsApi {
  private readonly home: string
  private readonly now: () => number
  private readonly injectedDb: SettingsDb | undefined
  private readonly descriptors = new Map<string, FieldDescriptor[]>()
  private readonly entries = new Map<string, Entry>()
  /** L1：单次覆盖（内存，不进任何持久层） */
  private readonly overrides = new Map<string, JsonValue>()
  /** L5：适配器组合基座（内存，由适配器注册） */
  private readonly adapterBase = new Map<string, JsonValue>()
  private readonly watchers = new Map<string, Set<(change: SettingsChange) => void>>()
  private opened = false

  constructor(options: LocalSettingsOptions) {
    this.home = options.home
    this.now = options.now ?? ((): number => nowEpochMs())
    this.injectedDb = options.db
  }

  // ─────────── 装配入口 ───────────

  /** 注册一个命名空间的字段描述符（L6 默认值 + 校验规则 + `describe()` 的数据源） */
  registerNamespace(descriptors: readonly FieldDescriptor[]): void {
    for (const descriptor of descriptors) {
      const list = this.descriptors.get(descriptor.namespace) ?? []
      list.push(descriptor)
      this.descriptors.set(descriptor.namespace, list)
    }
  }

  /** L1：单次覆盖（一次调用有效；`clearOverrides()` 收尾） */
  setOverride(namespace: string, key: string, value: JsonValue): void {
    this.overrides.set(`${namespace}\u0000${key}`, value)
  }

  clearOverrides(namespace?: string): void {
    if (namespace === undefined) {
      this.overrides.clear()
      return
    }
    for (const compound of [...this.overrides.keys()]) {
      if (compound.startsWith(`${namespace}\u0000`)) this.overrides.delete(compound)
    }
  }

  /** L5：适配器基座（由适配器包的 `apply()` 调用） */
  registerAdapterBase(namespace: string, key: string, value: JsonValue): void {
    this.adapterBase.set(`${namespace}\u0000${key}`, value)
  }

  /** 打开：先把 `settings.json`（L4 真相）灌进 `settings_kv`，再读回内存 */
  open(): void {
    if (this.opened) return
    this.opened = true
    this.syncFileIntoKv()
    this.loadKvIntoMemory()
  }

  // ─────────── `settings.*`（doc 21 §2.5） ───────────

  describe(namespace: string): readonly FieldDescriptor[] {
    const list = this.descriptors.get(namespace)
    if (list === undefined) throw notFound(namespace)
    // 只回元信息：描述符里没有任何"值"字段，凭据也只有引用名（12 §7.3）
    return [...list]
  }

  get(input: SettingsGetInput): SettingsGetResult {
    this.ensureOpen()
    const list = this.descriptors.get(input.namespace)
    if (list === undefined) throw notFound(input.namespace)
    const scope: ResolveScope = {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    }

    if (input.key !== undefined) {
      const resolved = this.resolveKey(input.namespace, input.key, scope)
      if (resolved !== null) return resolved
      // 描述符里连默认值都没有 → 视为"未设置"
      const descriptor = list.find((d) => d.key === input.key)
      if (descriptor === undefined) throw notFound(`${input.namespace}.${input.key}`)
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_FOUND,
        message: `设置项没有生效值，也没有默认值：${input.namespace}.${input.key}`,
        userMessage: '这个设置项还没有值。',
        retryable: false,
      })
    }

    // 省略 key：返回该命名空间的合并结果（逐字段合并，doc 18 §2.2 D-2）
    const merged: Record<string, JsonValue> = {}
    let bestLayer: LayerId = 'L6'
    for (const descriptor of list) {
      const resolved = this.resolveKey(input.namespace, descriptor.key, scope)
      if (resolved === null) continue
      setPath(merged, descriptor.key, resolved.value)
      if (LAYER_ORDER.indexOf(resolved.source) < LAYER_ORDER.indexOf(bestLayer)) bestLayer = resolved.source
    }
    return { value: merged, source: bestLayer }
  }

  async update(input: SettingsUpdateInput): Promise<SettingsUpdateResult> {
    this.ensureOpen()
    const list = this.descriptors.get(input.namespace)
    if (list === undefined) throw notFound(input.namespace)
    const descriptor = list.find((d) => d.key === input.key)
    if (descriptor === undefined) throw validationFailed(`未知设置项：${input.namespace}.${input.key}`)
    this.assertValid(descriptor, input.value)

    const scope = input.scope ?? 'user'
    const layer: 'L2' | 'L3' | 'L4' = scope === 'session' ? 'L2' : scope === 'workspace' ? 'L3' : 'L4'
    if (SCOPE_BY_LAYER[layer] !== scope) throw validationFailed(`scope 与层不匹配：${scope}`)
    const scopeRef = this.scopeRefOf(scope, input)
    const entry: Entry = { namespace: input.namespace, key: input.key, value: input.value, layer, scope, scopeRef }

    this.entries.set(key(entry), entry)
    this.writeKv(entry)
    if (layer === 'L4') this.writeSettingsFile()
    this.emit({ namespace: input.namespace, key: input.key, value: input.value, source: layer })
    return { saved: true, source: layer }
  }

  watch(namespace: string, handler: (change: SettingsChange) => void): () => void {
    const set = this.watchers.get(namespace) ?? new Set<(change: SettingsChange) => void>()
    set.add(handler)
    this.watchers.set(namespace, set)
    return () => {
      set.delete(handler)
    }
  }

  // ─────────── `SettingsService`（@lcode/settings 的冻结接口） ───────────
  //
  // 冻结接口与 `settings.*` 的**方法名冲突**（两边都叫 get / watch），TS 不允许
  // 同名双重实现——所以这里用 `*ByKey` 命名，再由 `toSettingsService()` 提供
  // 一个符合接口的适配对象。两种视图共用同一份状态，不会分叉。

  /** 冻结接口 `get(key, scope)` 的实体：dotted key（`model.default.maxTokens`） */
  getByKey(dottedKey: string, scope?: { readonly sessionId?: string; readonly workspace?: string }): SettingValue | undefined {
    this.ensureOpen()
    const at = dottedKey.indexOf('.')
    if (at <= 0) return undefined
    const namespace = dottedKey.slice(0, at)
    const rest = dottedKey.slice(at + 1)
    const resolveScope: ResolveScope = {
      ...(scope?.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      ...(scope?.workspace === undefined ? {} : { workspace: scope.workspace }),
    }
    const resolved = this.resolveKey(namespace, rest, resolveScope)
    if (resolved === null) return undefined
    return {
      value: resolved.value,
      layer: CONFIG_LAYER_BY_ID[resolved.source] as ConfigLayer,
      source: this.originOf(resolved.source),
    }
  }

  /** 冻结接口 `set(key, value, scope)` 的实体：写 L4（或按 scope 写 L3） */
  async setByKey(key: string, value: unknown, scope?: { readonly workspace?: string }): Promise<void> {
    const at = key.indexOf('.')
    if (at <= 0) throw validationFailed(`设置键格式非法（应为 namespace.key.path）：${key}`)
    const namespace = key.slice(0, at)
    const rest = key.slice(at + 1)
    await this.update({
      namespace,
      key: rest,
      value: value as JsonValue,
      ...(scope?.workspace === undefined ? {} : { scope: 'workspace' as const, workspace: scope.workspace }),
    })
  }

  /** 冻结接口 `watch(keys, fn)`：按 dotted key 前缀（即命名空间）订阅 */
  watchKeys(keys: readonly string[], fn: (changed: readonly string[]) => void): () => void {
    const changed = new Set<string>()
    const stops: (() => void)[] = []
    for (const dotted of keys) {
      const at = dotted.indexOf('.')
      const namespace = at <= 0 ? dotted : dotted.slice(0, at)
      stops.push(
        this.watch(namespace, (change) => {
          changed.add(`${change.namespace}.${change.key}`)
          fn([...changed])
        }),
      )
    }
    return () => {
      for (const stop of stops) stop()
    }
  }

  /**
   * 适配成 `@lcode/settings` 的冻结接口（ctx.settings）。
   * 只做转发，不持有第二份状态。
   */
  toSettingsService(): SettingsService {
    return {
      get: (key, scope) => this.getByKey(key, scope),
      set: (key, value, scope) => this.setByKey(key, value, scope),
      watch: (keys, fn) => this.watchKeys(keys, fn),
    }
  }

  close(): void {
    this.opened = false
  }

  // ─────────── 内部：解析 ───────────

  private ensureOpen(): void {
    if (!this.opened) this.open()
  }

  private db(): SettingsDb {
    return this.injectedDb ?? openIndexDb({ home: this.home })
  }

  private scopeRefOf(scope: SettingsScope, input: ResolveScope): string {
    if (scope === 'user') return ''
    if (scope === 'session') {
      if (input.sessionId === undefined) throw validationFailed('写 L2（会话层）必须给 sessionId')
      return input.sessionId
    }
    if (input.workspace === undefined) throw validationFailed('写 L3（工作区层）必须给 workspace')
    return normalizePath(input.workspace)
  }

  /** 逐字段合并：L1 → L2 → L3 → L4 → L5 → L6，命中即停（doc 18 §2.1） */
  private resolveKey(namespace: string, keyPath: string, scope: ResolveScope): SettingsGetResult | null {
    const compound = `${namespace}\u0000${keyPath}`
    const override = this.overrides.get(compound)
    if (override !== undefined) return { value: override, source: 'L1' }

    if (scope.sessionId !== undefined) {
      const entry = this.entries.get(
        key({ namespace, key: keyPath, layer: 'L2', scope: 'session', scopeRef: scope.sessionId }),
      )
      if (entry !== undefined) return { value: entry.value, source: 'L2' }
    }
    if (scope.workspace !== undefined) {
      const entry = this.entries.get(
        key({
          namespace,
          key: keyPath,
          layer: 'L3',
          scope: 'workspace',
          scopeRef: normalizePath(scope.workspace),
        }),
      )
      if (entry !== undefined) return { value: entry.value, source: 'L3' }
    }
    const user = this.entries.get(key({ namespace, key: keyPath, layer: 'L4', scope: 'user', scopeRef: '' }))
    if (user !== undefined) return { value: user.value, source: 'L4' }

    const base = this.adapterBase.get(compound)
    if (base !== undefined) return { value: base, source: 'L5' }

    const descriptor = this.descriptors.get(namespace)?.find((d) => d.key === keyPath)
    if (descriptor?.default !== undefined) return { value: descriptor.default, source: 'L6' }
    return null
  }

  private originOf(layer: LayerId): string {
    switch (layer) {
      case 'L1':
        return 'override'
      case 'L2':
        return 'session'
      case 'L3':
        return 'workspace'
      case 'L4':
        return 'settings.json'
      case 'L5':
        return 'adapter-base'
      default:
        return 'schema-default'
    }
  }

  private assertValid(descriptor: FieldDescriptor, value: JsonValue): void {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const expected = descriptor.type === 'enum' ? 'string' : descriptor.type
    if (expected !== 'object' && actual !== expected) {
      throw validationFailed(`${descriptor.namespace}.${descriptor.key} 期望 ${descriptor.type}，收到 ${actual}`)
    }
    if (descriptor.type === 'enum') {
      const allowed = descriptor.enumValues ?? []
      if (!allowed.includes(String(value))) {
        throw validationFailed(`${descriptor.namespace}.${descriptor.key} 只允许：${allowed.join(' / ')}`)
      }
    }
  }

  private emit(change: SettingsChange): void {
    for (const handler of this.watchers.get(change.namespace) ?? []) handler(change)
  }

  // ─────────── 内部：持久化 ───────────

  private settingsFilePath(): string {
    return join(this.home, 'settings.json')
  }

  /** `settings.json`（L4 真相）→ `settings_kv`（投影）。文件是权威方向，单向同步 */
  private syncFileIntoKv(): void {
    const file = this.settingsFilePath()
    if (!existsSync(file)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch {
      // 文件损坏时不猜：跳过同步，用户层视为空（doctor 会报，见 T6.4）
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const db = this.db()
    const statement = db.prepare(
      `INSERT INTO settings_kv (namespace, key, value_json, source_layer, scope, scope_ref, updated_at)
       VALUES (?, ?, ?, 'L4', 'user', '', ?)
       ON CONFLICT(namespace, key, source_layer, scope, scope_ref) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    const now = this.now()
    for (const [namespace, section] of Object.entries(parsed as Record<string, unknown>)) {
      if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
      for (const [keyPath, value] of flatten(section as Record<string, unknown>, '')) {
        statement.run(namespace, keyPath, JSON.stringify(value), now)
      }
    }
  }

  private loadKvIntoMemory(): void {
    const rows = this.db()
      .prepare('SELECT namespace, key, value_json, source_layer, scope, scope_ref FROM settings_kv')
      .all() as { namespace: string; key: string; value_json: string; source_layer: string; scope: string; scope_ref: string }[]
    for (const row of rows) {
      if (row.source_layer !== 'L2' && row.source_layer !== 'L3' && row.source_layer !== 'L4') continue
      this.entries.set(key({ ...row, layer: row.source_layer, scope: row.scope as SettingsScope, scopeRef: row.scope_ref }), {
        namespace: row.namespace,
        key: row.key,
        value: JSON.parse(row.value_json) as JsonValue,
        layer: row.source_layer,
        scope: row.scope as SettingsScope,
        scopeRef: row.scope_ref,
      })
    }
  }

  private writeKv(entry: Entry): void {
    this.db()
      .prepare(
        `INSERT INTO settings_kv (namespace, key, value_json, source_layer, scope, scope_ref, updated_at)
         VALUES (@namespace, @key, @value_json, @source_layer, @scope, @scope_ref, @updated_at)
         ON CONFLICT(namespace, key, source_layer, scope, scope_ref) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run({
        namespace: entry.namespace,
        key: entry.key,
        value_json: JSON.stringify(entry.value),
        source_layer: entry.layer,
        scope: entry.scope,
        scope_ref: entry.scopeRef,
        updated_at: this.now(),
      })
  }

  /** L4 的真相文件：原子物化（复用持久化包的实现，避免两套写法） */
  private writeSettingsFile(): void {
    const root: Record<string, JsonValue> = {}
    for (const entry of this.entries.values()) {
      if (entry.layer !== 'L4') continue
      const section = (root[entry.namespace] ?? {}) as Record<string, JsonValue>
      setPath(section, entry.key, entry.value)
      root[entry.namespace] = section
    }
    const file = this.settingsFilePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomicSync(file, JSON.stringify(root, null, 2) + '\n')
  }
}

/** 把嵌套对象摊平成 `a.b` → value（settings.json 的读取方向） */
function flatten(node: Record<string, unknown>, prefix: string): [string, JsonValue][] {
  const out: [string, JsonValue][] = []
  for (const [segment, value] of Object.entries(node)) {
    const path = prefix === '' ? segment : `${prefix}.${segment}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flatten(value as Record<string, unknown>, path))
    } else {
      out.push([path, value as JsonValue])
    }
  }
  return out
}
