/** 插件清单（lcode.json，文档 13 §6） */
export interface PluginManifest {
  readonly name: string
  readonly version: string
  readonly description?: string
  /** 内核版本兼容性（EX-INCOMPATIBLE 判据） */
  readonly engines: { readonly lcode: string }
  /** 声明权限（运行时注册未声明的能力 → EX-UNDECLARED_PERMISSION） */
  readonly permissions: readonly string[]
}
