import type {} from '@lcode/context'
import type { JsonValue } from '@lcode/util'

export type CodeLanguage = 'javascript'

/** 一个语言无关的 namespace；运行器不知道其背后是工具、数据库还是其他 provider。 */
export interface CodeBindingNamespace {
  readonly global: string
  readonly functions: readonly string[]
}

export interface CodeRunRequest {
  readonly program: string
  readonly language: CodeLanguage
  readonly bindings: readonly CodeBindingNamespace[]
  /** provider 通过这条受控回调请求宿主操作，不能直接取得宿主服务。 */
  invoke(binding: string, args: JsonValue): Promise<JsonValue>
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

export interface CodeRunResult {
  readonly value?: JsonValue | undefined
  readonly logs: readonly string[]
  /** 程序/运行器失败是结构化结果，不把 agent loop 弄成异常控制流。 */
  readonly error?: { readonly code: string; readonly message: string } | undefined
}

export interface CodeRuntime {
  readonly languages: readonly CodeLanguage[]
  run(input: CodeRunRequest): Promise<CodeRunResult>
}

declare module '@lcode/context' {
  interface Services { codeRuntime: CodeRuntime }
}

export type { JsonValue }
