import { t } from '../i18n/index.ts'

export type AgentPresetId = 'standard' | 'creator'

export interface AgentPresetState {
  readonly preset: AgentPresetId
  readonly source: 'default' | 'user'
  readonly changedAt?: number | undefined
}

export interface AgentPresetOption {
  readonly id: AgentPresetId
  readonly name: string
  readonly description: string
  readonly available: boolean
}

interface AgentPresetBridge {
  get(): Promise<unknown>
  set(input: { readonly preset: AgentPresetId }): Promise<unknown>
  list(): Promise<unknown>
}

function bridge(): AgentPresetBridge | undefined {
  return (globalThis as unknown as { lcode?: { agentPreset?: AgentPresetBridge } }).lcode?.agentPreset
}

export function agentPresetLabel(id: AgentPresetId): string {
  return id === 'creator' ? t('创造模式') : t('标准模式')
}

export async function getAgentPreset(): Promise<AgentPresetState | undefined> {
  const api = bridge()
  if (api === undefined) return undefined
  const value = (await api.get()) as AgentPresetState
  return value?.preset === undefined ? undefined : value
}

export async function chooseAgentPreset(preset: AgentPresetId): Promise<AgentPresetState | undefined> {
  const api = bridge()
  if (api === undefined) return undefined
  const value = (await api.set({ preset })) as AgentPresetState
  return value?.preset === undefined ? undefined : value
}

export async function listAgentPresets(): Promise<{ readonly presets: readonly AgentPresetOption[]; readonly current: AgentPresetState | undefined }> {
  const api = bridge()
  if (api === undefined) return { presets: [], current: undefined }
  const value = (await api.list()) as { presets?: readonly AgentPresetOption[]; current?: AgentPresetState }
  return { presets: Array.isArray(value?.presets) ? value.presets : [], current: value?.current }
}
