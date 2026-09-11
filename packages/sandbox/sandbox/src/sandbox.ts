/** 沙箱状态（doctor --sandbox 的输出） */
export interface SandboxStatus {
  readonly available: boolean
  readonly mechanism: string
  readonly knownEscapeSurfaces: readonly string[]
  readonly degraded: boolean
}

/**
 * SandboxService —— OS 原生沙箱约束（文档 12 / D13）。
 * 约束即将 spawn 的 argv / 即将打开的路径；失败必须可归因，不得静默降级（C3）。
 */
export interface SandboxService {
  status(): Promise<SandboxStatus>
  /** 检查一组命令是否被允许（即将 spawn 前调用） */
  canSpawn(argv: readonly string[], opts?: { readonly cwd?: string }): Promise<{ allowed: boolean; reason?: string }>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    sandbox: SandboxService
  }
}
