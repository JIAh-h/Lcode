/** 凭据解析结果（值只在调用链内传递，永不进日志/UI/导出，I7） */
export interface ResolvedCredential {
  readonly refName: string
  readonly value: string
  /** 生效来源（D22）：env / lcode-home-env / project-env / keychain */
  readonly source: 'env' | 'lcode-home-env' | 'project-env' | 'keychain'
}

/** CredentialsService —— 凭据引用解析（每次操作重新解析，不缓存） */
export interface CredentialsService {
  resolve(refName: string, opts?: { readonly cwd?: string }): Promise<ResolvedCredential | undefined>
  /** 只返回来源信息（UI 显示"当前生效来源"用），不返回值 */
  describeSource(refName: string, opts?: { readonly cwd?: string }): Promise<string | undefined>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    credentials: CredentialsService
  }
}
