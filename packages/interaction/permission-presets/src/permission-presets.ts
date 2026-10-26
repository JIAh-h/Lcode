import type { SandboxMode } from '@lcode/sandbox'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 权限预设（12 §3.3；22 §6.4）。
 *
 * ## 用户看到一档，内核拿到的是一条"两条轴的打包"
 *
 * 底层只有 `{sandbox/mode, approval/policy}` 两个词表，预设是它们的命名取值。
 * 之所以**不暴露这两条轴**（`SEC-AXES-001`）：用户想的是"它什么时候问我"，
 * 而不是"沙箱档位 × 审批策略的笛卡尔积"。把它们摊在设置页上会让用户被迫理解
 * 一个实现模型，而那个模型的任何变化都会变成界面的变化。
 *
 * | 预设 | `sandbox/mode` | `approval/policy` | 用户预期 |
 * |---|---|---|---|
 * | 只读 | `read-only` | `ask` | 它只能看，不能改 |
 * | **工作区内修改**（默认） | `workspace-write` | `ask` | 能改工作区内的文件，动手前问我 |
 * | 完全访问 | `danger-full-access` | `ask` | 哪里都能碰，但动手前问我 |
 *
 * 2026-10-26 收敛为三档：移除「自动审批 / 无人值守」。产品上不再提供“不问人”
 * 的权限档；`never` 策略保留在底层（审批通道缺席时仍 fail-closed），只是没有预设映射。
 *
 * ## `never` **不等于**"默认允许"
 *
 * 这是最容易读错的一格。`never` 的含义是"**别问我**"，不是"**都放行**"：
 * 遇到 12 §9.3 的高风险动作时，`ask` 档会**问**，`never` 档直接**拒绝**。
 * 把 `never` 实现成放行，等于把"无人值守"变成"无防护"。
 */

export const PERMISSION_PRESETS = ['只读', '工作区内修改', '完全访问'] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/** `approval/policy` 的两个取值 */
export type ApprovalPolicy = 'ask' | 'never'

export interface PresetKnobs {
  readonly sandboxMode: SandboxMode
  readonly approvalPolicy: ApprovalPolicy
}

/** 预设 → 两条轴（12 §3.3 的表格，逐格对应） */
export const PRESET_KNOBS: Readonly<Record<PermissionPreset, PresetKnobs>> = {
  只读: { sandboxMode: 'read-only', approvalPolicy: 'ask' },
  工作区内修改: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
  完全访问: { sandboxMode: 'danger-full-access', approvalPolicy: 'ask' },
}

export const DEFAULT_PRESET: PermissionPreset = '工作区内修改'

/** 预设的用户可读说明（与 UI 里那份是同一段文字） */
export const PRESET_HINT: Readonly<Record<PermissionPreset, string>> = {
  只读: '它只能看，不能改',
  工作区内修改: '能改工作区内的文件；越界或高风险动作前问你',
  完全访问: '哪里都能碰，但动手前问我',
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

/** 把预设解成两条轴 */
export function knobsOf(preset: PermissionPreset): PresetKnobs {
  return PRESET_KNOBS[preset]
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    permissionPresets: PermissionPresetService
  }
  interface Events {
    /** 切换预设（12 §3.3：**同时改两条轴**，一次事件记全） */
    'permissionPresets/preset': { readonly preset: PermissionPreset; readonly knobs: PresetKnobs }
    /** 工作区信任变化（12 §10） */
    'workspace/trust': { readonly workspace: string; readonly trusted: boolean }
  }
}

/**
 * 当前预设的唯一归属。
 *
 * 有 `watch` 是因为沙箱策略与审批策略**都要读它**，而用户随时可能在设置里改——
 * 让每个消费者自己去轮询会制造出"设置页改了、引擎还用旧的"那类偏差。
 */
export interface PermissionPresetService {
  get(): PermissionPreset
  set(preset: PermissionPreset): Promise<void>
  watch(fn: (preset: PermissionPreset) => void): () => void
  snapshot(): PermissionPresetSnapshot
  audit(): readonly PermissionPresetAudit[]
}

/** 当前值及其来源；renderer 只显示这层语义，不暴露底层两条策略轴。 */
export interface PermissionPresetSnapshot {
  readonly preset: PermissionPreset
  readonly source: 'default' | 'user'
  readonly changedAt?: number | undefined
}

/** 最近的切换记录。它是设置审计，不包含工作区路径、命令或任何密钥。 */
export interface PermissionPresetAudit {
  readonly from: PermissionPreset
  readonly to: PermissionPreset
  readonly changedAt: number
}

/** 内存实现（骨架阶段；持久化由装配层接到 settings，与默认模型同一套做法） */
export class InMemoryPermissionPresets implements PermissionPresetService {
  private current: PermissionPreset
  private readonly watchers = new Set<(preset: PermissionPreset) => void>()
  private readonly changes: PermissionPresetAudit[] = []
  private source: PermissionPresetSnapshot['source'] = 'default'
  private changedAt: number | undefined

  constructor(initial: PermissionPreset = DEFAULT_PRESET) {
    this.current = initial
  }

  get(): PermissionPreset {
    return this.current
  }

  async set(preset: PermissionPreset): Promise<void> {
    if (preset === this.current) return
    const from = this.current
    this.current = preset
    this.source = 'user'
    this.changedAt = Date.now()
    this.changes.unshift({ from, to: preset, changedAt: this.changedAt })
    for (const fn of this.watchers) fn(preset)
  }

  watch(fn: (preset: PermissionPreset) => void): () => void {
    this.watchers.add(fn)
    return () => {
      this.watchers.delete(fn)
    }
  }

  snapshot(): PermissionPresetSnapshot {
    return { preset: this.current, source: this.source, ...(this.changedAt === undefined ? {} : { changedAt: this.changedAt }) }
  }

  audit(): readonly PermissionPresetAudit[] {
    return [...this.changes]
  }
}

interface PersistedPermissionPresets {
  readonly version: 1
  readonly preset: PermissionPreset
  readonly source: 'default' | 'user'
  readonly changedAt?: number | undefined
  readonly audit: readonly PermissionPresetAudit[]
}

export interface LocalPermissionPresetsOptions {
  readonly home: string
  readonly now?: (() => number) | undefined
}

/**
 * 权限预设的宿主侧持久化实现。
 *
 * 放在 LCODE_HOME 而非工作区：项目不能通过提交配置文件来抬高本机权限；写入采用
 * 临时文件 rename，进程中断时仍保留上一份有效配置。审计只留最近 20 次，避免设置文件
 * 无限增长。
 */
export function createLocalPermissionPresets(options: LocalPermissionPresetsOptions): PermissionPresetService {
  const file = resolve(options.home, 'permission-preset.json')
  const now = options.now ?? (() => Date.now())
  let state = loadPersisted(file)
  const watchers = new Set<(preset: PermissionPreset) => void>()

  return {
    get: () => state.preset,
    async set(preset) {
      if (preset === state.preset) return
      const changedAt = now()
      const next: PersistedPermissionPresets = {
        version: 1,
        preset,
        source: 'user',
        changedAt,
        audit: [{ from: state.preset, to: preset, changedAt }, ...state.audit].slice(0, 20),
      }
      persist(file, next)
      state = next
      for (const watcher of watchers) watcher(preset)
    },
    watch(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
    snapshot() {
      return {
        preset: state.preset,
        source: state.source,
        ...(state.changedAt === undefined ? {} : { changedAt: state.changedAt }),
      }
    },
    audit: () => [...state.audit],
  }
}

/**
 * 旧版本落盘的预设名 → 当前词表。
 * 2026-10-26 收敛为三档：旧的 `标准` / `自动` / `自动审批` / `无人值守` 统一迁移到
 * `工作区内修改`（更保守：自动审批原本不问人，现在会恢复逐次审批）。
 */
function normalizePreset(value: unknown): PermissionPreset | undefined {
  if (value === '标准' || value === '自动' || value === '自动审批' || value === '无人值守') return '工作区内修改'
  return isPermissionPreset(value) ? value : undefined
}

function loadPersisted(file: string): PersistedPermissionPresets {
  const fallback: PersistedPermissionPresets = { version: 1, preset: DEFAULT_PRESET, source: 'default', audit: [] }
  if (!existsSync(file)) return fallback
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedPermissionPresets>
    const preset = normalizePreset(value.preset)
    if (value.version !== 1 || preset === undefined || value.source !== 'user' || typeof value.changedAt !== 'number' || !Array.isArray(value.audit)) {
      return fallback
    }
    const audit = value.audit.flatMap((entry) => {
      const from = normalizePreset(entry?.from)
      const to = normalizePreset(entry?.to)
      return from !== undefined && to !== undefined && typeof entry.changedAt === 'number'
        ? [{ from, to, changedAt: entry.changedAt }]
        : []
    }).slice(0, 20)
    return { version: 1, preset, source: 'user', changedAt: value.changedAt, audit }
  } catch {
    // 损坏配置不能变成更宽松的权限，安全回落到默认“标准”。
    return fallback
  }
}

function persist(file: string, value: PersistedPermissionPresets): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}
