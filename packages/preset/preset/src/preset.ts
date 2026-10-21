import type {} from '@lcode/context'

export interface PresetCatalogEntry {
  readonly id: string
  readonly name: string
  readonly source: 'user' | 'workspace'
}

/** PresetService —— 预设（agent 会话级插件组合） */
export interface PresetService {
  list(): Promise<readonly PresetCatalogEntry[]>
  load(id: string): Promise<{ readonly config: string; readonly path: string; readonly source: PresetCatalogEntry['source'] } | undefined>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    presets: PresetService
  }
}
