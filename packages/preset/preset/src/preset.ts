/** PresetService —— 预设（agent 会话级插件组合） */
export interface PresetService {
  list(): Promise<readonly { readonly id: string; readonly name: string }[]>
  load(id: string): Promise<{ readonly config: string } | undefined>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    presets: PresetService
  }
}
