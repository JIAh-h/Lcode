import type { SandboxMode } from '@lcode/sandbox'

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
 * | **标准**（默认） | `workspace-write` | `ask` | 能改我的项目，动手前问我 |
 * | 自动 | `workspace-write` | `never` | 工作区内自己干，不打扰我 |
 * | 完全访问 | `danger-full-access` | `ask` | 哪里都能碰，但动手前问我 |
 * | 无人值守 | `workspace-write` | `never` | 用于自动化，不打扰你 |
 *
 * ## `never` **不等于**"默认允许"
 *
 * 这是最容易读错的一格。`never` 的含义是"**别问我**"，不是"**都放行**"：
 * 遇到 12 §9.3 的高风险动作时，`ask` 档会**问**，`never` 档直接**拒绝**。
 * 把 `never` 实现成放行，等于把"无人值守"变成"无防护"。
 */

export const PERMISSION_PRESETS = ['只读', '标准', '自动', '完全访问', '无人值守'] as const
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
  标准: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
  自动: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  完全访问: { sandboxMode: 'danger-full-access', approvalPolicy: 'ask' },
  无人值守: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
}

export const DEFAULT_PRESET: PermissionPreset = '标准'

/** 预设的用户可读说明（与 UI 里那份是同一段文字） */
export const PRESET_HINT: Readonly<Record<PermissionPreset, string>> = {
  只读: '它只能看，不能改',
  标准: '能改我的项目，动手前问我',
  自动: '工作区内自己干，不打扰我',
  完全访问: '哪里都能碰，但动手前问我',
  无人值守: '用于自动化，不打扰我',
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
}

/** 内存实现（骨架阶段；持久化由装配层接到 settings，与默认模型同一套做法） */
export class InMemoryPermissionPresets implements PermissionPresetService {
  private current: PermissionPreset
  private readonly watchers = new Set<(preset: PermissionPreset) => void>()

  constructor(initial: PermissionPreset = DEFAULT_PRESET) {
    this.current = initial
  }

  get(): PermissionPreset {
    return this.current
  }

  async set(preset: PermissionPreset): Promise<void> {
    this.current = preset
    for (const fn of this.watchers) fn(preset)
  }

  watch(fn: (preset: PermissionPreset) => void): () => void {
    this.watchers.add(fn)
    return () => {
      this.watchers.delete(fn)
    }
  }
}
