import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Agent 预设的全局默认值（本机设置）。
 *
 * 与权限预设正交：预设决定“Agent 用哪些工具、怎么工作”，权限决定“能碰什么”。
 * 目前只有「标准模式」可选；「创造模式」是占位（需要先定义插件/技能创作规范）。
 */
export type AgentPresetId = 'standard' | 'creator'

/** 当前允许用户选择的预设（创造模式规范完成前仅占位展示）。 */
export const SELECTABLE_AGENT_PRESETS: readonly AgentPresetId[] = ['standard']

export interface AgentPresetSnapshot {
  readonly preset: AgentPresetId
  readonly source: 'default' | 'user'
  readonly changedAt?: number | undefined
}

export interface AgentPresetSettingService {
  get(): AgentPresetId
  snapshot(): AgentPresetSnapshot
  set(preset: AgentPresetId): Promise<AgentPresetSnapshot>
  watch(fn: (preset: AgentPresetId) => void): () => void
}

export interface LocalAgentPresetSettingOptions {
  readonly home: string
  readonly now?: (() => number) | undefined
}

interface PersistedAgentPreset {
  readonly version: 1
  readonly preset: string
  readonly changedAt: number
}

const DEFAULT_PRESET: AgentPresetId = 'standard'

function isSelectable(value: unknown): value is AgentPresetId {
  return typeof value === 'string' && (SELECTABLE_AGENT_PRESETS as readonly string[]).includes(value)
}

export function createLocalAgentPresetSetting(options: LocalAgentPresetSettingOptions): AgentPresetSettingService {
  const file = join(options.home, 'agent-preset.json')
  const now = options.now ?? (() => Date.now())
  let state = load(file)
  const watchers = new Set<(preset: AgentPresetId) => void>()

  return {
    get: () => state.preset,
    snapshot: () => state,
    async set(preset) {
      if (!isSelectable(preset)) throw new Error('这个 Agent 预设尚未开放')
      if (preset === state.preset) return state
      const next: PersistedAgentPreset = { version: 1, preset, changedAt: now() }
      persist(file, next)
      state = { preset, source: 'user', changedAt: next.changedAt }
      for (const watcher of watchers) watcher(preset)
      return state
    },
    watch(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
  }
}

function load(file: string): AgentPresetSnapshot {
  if (!existsSync(file)) return { preset: DEFAULT_PRESET, source: 'default' }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedAgentPreset>
    if (value.version !== 1 || !isSelectable(value.preset) || typeof value.changedAt !== 'number') {
      return { preset: DEFAULT_PRESET, source: 'default' }
    }
    return { preset: value.preset, source: 'user', changedAt: value.changedAt }
  } catch {
    return { preset: DEFAULT_PRESET, source: 'default' }
  }
}

function persist(file: string, value: PersistedAgentPreset): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    agentPreset: AgentPresetSettingService
  }
}
