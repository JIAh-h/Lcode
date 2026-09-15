import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openIndexDb } from '@lcode/session-persistence-sqlite'
import { ERROR_CODES, LcodeErrorImpl, normalizePath, nowEpochMs } from '@lcode/util'
import { writeFileAtomicSync } from '@lcode/util/fs-atomic'
import type { JsonValue } from '@lcode/util'
import type { CredentialsService, ResolvedCredential } from '@lcode/credentials'

/**
 * 凭据解析与记录存储（doc 12 §7；实施计划 T4.3）。
 *
 * ## 核心约束：线上一律没有明文
 *
 * 取值的唯一入口是 `resolve(refName)`，它**只在发起方进程内被调用**，返回值是
 * 普通 `string`，**不进入任何可序列化的公共对象**（12 §7.3）。所有对外的
 * `CredentialInfo` 都没有、也不会有 `value` 字段——这是**类型层面的保证**，
 * 不是"我们保证不打日志"的纪律。
 *
 * ## 每次操作重新解析（D22 / 12 §7.2）
 *
 * 不在会话开始时把凭据抓一次存起来。轮换的凭据对下一个请求立即生效。
 * 因此本实现**没有跨操作缓存**；`resolve()` 每次都重走层序。
 *
 * ## 层序（按 `@lcode/credentials` 冻结的 source 取值域实现）
 *
 * ```
 * ① 凭据记录（本机 0600 文件 / OS keychain）  → source: 'keychain'
 * ② 项目级 .env（<cwd>/.env）                → source: 'project-env'
 * ③ Lcode Home 的 .env（~/.lcode/.env）      → source: 'lcode-home-env'
 * ④ 进程环境变量                              → source: 'env'
 * ```
 *
 * 与 [12 §7.1](../../../docs/12-安全权限与沙箱模型.md) 的四步层序对应关系：
 * ①②③④ 覆盖了那里的 ②（用户配置记录）与 ③④（环境层）。
 * **那里的 ①"会话级临时覆盖"在本批次未实现**——冻结的 `source` 取值域里没有
 * `'session'`，要加得走 ADR（已记在 docs/24 未决项）。
 *
 * ## 值的存放：OS keychain 优先，0600 文件兜底（12 §7.4）
 *
 * Node 侧没有内建 keychain API（需要原生依赖）。本实现**默认走 0600 文件**，
 * 并把 keychain 探测结果如实报出来（`keychainAvailable()`），
 * `credentials_refs.backend` 记录事实，不假装用了 keychain。
 */

export type CredentialRefKind = 'env-ref' | 'record'
export type CredentialScopeKind = string
export type CredentialBackend = 'keychain' | 'file-0600' | 'env' | 'session'

/** 线上可返回的凭据元信息（doc 21 §2.6 / 12 §7.3）——**没有 value 字段** */
export interface CredentialInfo {
  /** `<scope>/<id>` 形态的稳定标识（如 `llm/deepseek-default`） */
  readonly key: string
  /** 环境变量名形态的引用名（如 `DEEPSEEK_API_KEY`） */
  readonly ref?: string | undefined
  readonly present: boolean
  readonly source?: CredentialBackend | undefined
  readonly updatedAt?: number | undefined
  readonly lastUsedAt?: number | undefined
  readonly maskedHint?: string | undefined
}

export interface WriteCredentialResult {
  readonly keyId: string
  readonly info: CredentialInfo
}

export interface LocalCredentialsOptions {
  readonly home: string
  /** 注入连接（测试用） */
  readonly db?: ReturnType<typeof openIndexDb> | undefined
  readonly now?: (() => number) | undefined
  /** 环境变量白名单；给了就只解析名单内的名字（12 §7.1「白名单内」） */
  readonly envAllowlist?: readonly string[] | undefined
}

interface RecordRow {
  readonly ref: string
  readonly scope: string
  readonly key_id: string | null
  readonly backend: CredentialBackend
  readonly updated_at: number
  readonly last_used_at: number | null
  readonly masked_hint: string | null
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function missingCredential(refName: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EL_CREDENTIAL_MISSING,
    message: `凭据解析失败：没有任何一层命中 ${refName}`,
    userMessage: '缺少模型凭据。请到「设置 → 模型」里填一个 API Key。',
    retryable: false,
  })
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_INVALID_PARAMS,
    message,
    userMessage: '这个请求的参数不对。',
    retryable: false,
  })
}

/** 遮蔽提示：只够"确认是哪一个"，不泄露内容（12 §7.3 的 `sk-…9f2c`） */
export function maskedHintOf(value: string): string {
  if (value.length < 8) return '…'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

/** 解析 `.env` 文本（`KEY=VALUE`；`#` 注释；引号剥离）。失败不猜，跳过坏行 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const name = line.slice(0, at).trim().replace(/^export\s+/, '')
    if (!ENV_NAME.test(name)) continue
    let value = line.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[name] = value
  }
  return out
}

export class LocalCredentialsService implements CredentialsService {
  private readonly home: string
  private readonly now: () => number
  private readonly injectedDb: ReturnType<typeof openIndexDb> | undefined
  private readonly envAllowlist: Set<string> | null

  constructor(options: LocalCredentialsOptions) {
    this.home = options.home
    this.now = options.now ?? ((): number => nowEpochMs())
    this.injectedDb = options.db
    this.envAllowlist = options.envAllowlist === undefined ? null : new Set(options.envAllowlist)
  }

  /** OS keychain 是否可用。如实上报——不假装用了 keychain（12 §7.4） */
  keychainAvailable(): boolean {
    // Node 侧没有内建 keychain API；接入 @napi keychain 属平台适配批次
    return false
  }

  /** 生效后端：目前恒为 0600 文件（keychain 不可用时文档指定的回退路径） */
  private backend(): CredentialBackend {
    return this.keychainAvailable() ? 'keychain' : 'file-0600'
  }

  /**
   * **唯一取值入口**（`in`：不跨进程，doc 21 §2.6）。
   * 每次调用重新走层序，不缓存（12 §7.2）。
   */
  async resolve(refName: string, opts?: { readonly cwd?: string }): Promise<ResolvedCredential | undefined> {
    return this.resolveInternal(refName, opts?.cwd, true)
  }

  /** 解析但不更新 `last_used_at`（`describeSource` / `listRefs` 不该算"使用过"） */
  private async resolveInternal(
    refName: string,
    cwd: string | undefined,
    touch: boolean,
  ): Promise<ResolvedCredential | undefined> {
    if (typeof refName !== 'string' || refName.trim() === '') throw invalidParams('refName 必填')
    const name = refName.trim()

    // ① 凭据记录
    const record = this.findRecordByRef(name)
    if (record !== null) {
      const value = this.readStoredValue(record.ref)
      if (value !== undefined) {
        if (touch) this.touch(record.ref)
        return { refName: name, value, source: 'keychain' }
      }
    }

    // ② 项目级 .env
    if (cwd !== undefined) {
      const fromProject = parseEnvFile(this.readIfExists(join(normalizePath(cwd), '.env')))
      const hit = fromProject[name]
      if (hit !== undefined) return { refName: name, value: hit, source: 'project-env' }
    }

    // ③ Lcode Home 的 .env
    const fromHome = parseEnvFile(this.readIfExists(join(this.home, '.env')))
    if (fromHome[name] !== undefined) return { refName: name, value: fromHome[name]!, source: 'lcode-home-env' }

    // ④ 进程环境变量（受白名单约束）
    if (this.envAllowed(name)) {
      const fromEnv = process.env[name]
      if (typeof fromEnv === 'string' && fromEnv !== '') return { refName: name, value: fromEnv, source: 'env' }
    }

    return undefined
  }

  /** 解析失败时抛具名错误（`EL-CREDENTIAL_MISSING`）；适合"必须有"的调用点 */
  async require(refName: string, opts?: { readonly cwd?: string }): Promise<ResolvedCredential> {
    const resolved = await this.resolve(refName, opts)
    if (resolved === undefined) throw missingCredential(refName)
    return resolved
  }

  /** 只回来源，不回值（UI 显示"当前生效来源"用） */
  async describeSource(refName: string, opts?: { readonly cwd?: string }): Promise<string | undefined> {
    const resolved = await this.resolveInternal(refName, opts?.cwd, false)
    return resolved?.source
  }

  /** 列出可用凭据的**元信息**（doc 21 §2.6 `credentials.listRefs`） */
  async listRefs(scope?: string): Promise<readonly CredentialInfo[]> {
    const rows = this.db()
      .prepare(
        `SELECT ref, scope, key_id, backend, updated_at, last_used_at, masked_hint
         FROM credentials_refs ${scope === undefined ? '' : 'WHERE scope = ?'} ORDER BY ref`,
      )
      .all(...(scope === undefined ? [] : [scope])) as RecordRow[]
    const out: CredentialInfo[] = []
    for (const row of rows) {
      // env-ref 的"存在性"要看环境能不能解析出来；record 的看后端里有没有值
      const present =
        row.backend === 'env'
          ? (await this.resolveInternal(row.ref, undefined, false)) !== undefined
          : this.readStoredValue(row.ref) !== undefined
      out.push({
        key: row.ref,
        ref: row.ref,
        present,
        source: row.backend,
        updatedAt: row.updated_at,
        ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
        ...(row.masked_hint === null ? {} : { maskedHint: row.masked_hint }),
      })
    }
    return out
  }

  /**
   * 写入一条凭据记录（doc 21 §2.6 `credentials.write`）。
   * 值只落后端（0600 文件），`credentials_refs` 里只有元信息与遮蔽提示。
   */
  async write(key: string, value: string, scope = 'llm'): Promise<WriteCredentialResult> {
    if (typeof key !== 'string' || key.trim() === '') throw invalidParams('key 必填')
    if (typeof value !== 'string' || value === '') throw invalidParams('value 必填')
    if (!ENV_NAME.test(key.trim())) throw invalidParams(`引用名非法（应为字母/数字/下划线且不以数字开头）：${key}`)
    const refName = key.trim()
    const keyId = createHash('sha256').update(`${scope}/${refName}`).digest('hex').slice(0, 16)
    const backend = this.backend()
    const now = this.now()
    const masked = maskedHintOf(value)

    this.writeStoredValue(refName, value)
    this.db()
      .prepare(
        `INSERT INTO credentials_refs (ref, ref_kind, scope, backend, key_id, masked_hint, created_at, updated_at)
         VALUES (@ref, 'record', @scope, @backend, @key_id, @masked_hint, @now, @now)
         ON CONFLICT(ref, scope) DO UPDATE SET
           backend = excluded.backend, key_id = excluded.key_id,
           masked_hint = excluded.masked_hint, updated_at = excluded.updated_at`,
      )
      .run({ ref: refName, scope, backend, key_id: keyId, masked_hint: masked, now })

    return {
      keyId,
      info: { key: refName, ref: refName, present: true, source: backend, updatedAt: now, maskedHint: masked },
    }
  }

  /** 删除一条记录（值与行一起删；`EC-NOT_FOUND` 由调用方按 `deleted:false` 判断） */
  async delete(key: string): Promise<{ deleted: boolean }> {
    const refName = key.trim()
    const file = this.valuePath(refName)
    const existed = existsSync(file)
    if (existed) rmSync(file, { force: true })
    const result = this.db().prepare('DELETE FROM credentials_refs WHERE ref = ?').run(refName)
    return { deleted: existed || result.changes > 0 }
  }

  /** 只把**引用**登记进 `credentials_refs`（值在环境变量里，不落库） */
  async registerEnvRef(refName: string, scope = 'llm'): Promise<void> {
    if (!ENV_NAME.test(refName)) throw invalidParams(`引用名非法：${refName}`)
    const now = this.now()
    this.db()
      .prepare(
        `INSERT INTO credentials_refs (ref, ref_kind, scope, backend, key_id, masked_hint, created_at, updated_at)
         VALUES (?, 'env-ref', ?, 'env', NULL, NULL, ?, ?)
         ON CONFLICT(ref, scope) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(refName, scope, now, now)
  }

  /** 便于集束/测试注入 ctx：`@lcode/credentials` 的冻结接口视图 */
  asCredentialsService(): CredentialsService {
    return {
      resolve: (refName, opts) => this.resolve(refName, opts),
      describeSource: (refName, opts) => this.describeSource(refName, opts),
    }
  }

  // ─────────── 内部：存储 ───────────

  private credentialsDir(): string {
    return join(this.home, 'credentials')
  }

  private valuePath(refName: string): string {
    const file = createHash('sha256').update(refName).digest('hex').slice(0, 24)
    return join(this.credentialsDir(), `${file}.json`)
  }

  private writeStoredValue(refName: string, value: string): void {
    const file = this.valuePath(refName)
    mkdirSync(this.credentialsDir(), { recursive: true })
    const payload: JsonValue = { ref: refName, value, updatedAt: this.now() }
    writeFileAtomicSync(file, JSON.stringify(payload))
    try {
      // 0600：仅本用户可读写（Windows 上 chmod 语义有限，尽力而为并如实记录后端）
      chmodSync(file, 0o600)
    } catch {
      /* Windows / 受限文件系统：权限位不生效，不中断写入 */
    }
  }

  private readStoredValue(refName: string): string | undefined {
    const text = this.readIfExists(this.valuePath(refName))
    if (text === '') return undefined
    try {
      const parsed = JSON.parse(text) as { value?: unknown }
      return typeof parsed.value === 'string' ? parsed.value : undefined
    } catch {
      return undefined
    }
  }

  private readIfExists(file: string): string {
    try {
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    } catch {
      return ''
    }
  }

  private findRecordByRef(refName: string): RecordRow | null {
    const row = this.db()
      .prepare(
        `SELECT ref, scope, key_id, backend, updated_at, last_used_at, masked_hint
         FROM credentials_refs WHERE ref = ? AND ref_kind = 'record' LIMIT 1`,
      )
      .get(refName) as RecordRow | undefined
    return row ?? null
  }

  private touch(refName: string): void {
    this.db().prepare('UPDATE credentials_refs SET last_used_at = ? WHERE ref = ?').run(this.now(), refName)
  }

  private envAllowed(name: string): boolean {
    return this.envAllowlist === null || this.envAllowlist.has(name)
  }

  private db(): ReturnType<typeof openIndexDb> {
    return this.injectedDb ?? openIndexDb({ home: this.home })
  }
}
