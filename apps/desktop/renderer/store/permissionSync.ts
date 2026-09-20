import { setPermissionPreset } from './uiPrefs.ts'
import type { PermissionPreset } from './uiPrefs.ts'

export interface PermissionPresetState {
  readonly preset: PermissionPreset
  readonly source: 'default' | 'user'
  readonly changedAt?: number
  readonly audit: readonly { readonly from: PermissionPreset; readonly to: PermissionPreset; readonly changedAt: number }[]
}

interface PermissionBridge {
  get(): Promise<PermissionPresetState>
  set(input: { readonly preset: PermissionPreset }): Promise<PermissionPresetState>
}

function bridge(): PermissionBridge | undefined {
  return (globalThis as unknown as { lcode?: { permissions?: PermissionBridge } }).lcode?.permissions
}

/** 同步主进程实际生效的预设；无桌面桥时保留 UI 的安全默认值。 */
export async function syncPermissionPresetFromMain(): Promise<PermissionPresetState | undefined> {
  const api = bridge()
  if (api === undefined) return undefined
  const state = await api.get()
  setPermissionPreset(state.preset)
  return state
}

/** 先写主进程，再更新 renderer 镜像，杜绝“界面已切换、策略仍是旧值”。 */
export async function choosePermissionPreset(preset: PermissionPreset): Promise<PermissionPresetState | undefined> {
  const api = bridge()
  if (api === undefined) return undefined
  const state = await api.set({ preset })
  setPermissionPreset(state.preset)
  return state
}
