import type { CodeRuntime, JsonValue } from '@lcode/code-runtime'
import type { ToolDefinition, ToolRegistry } from '@lcode/tools'
import { randomUUID } from 'node:crypto'

interface RunCodeInput { readonly code: string; readonly language?: 'javascript' | undefined }

/**
 * Consumer 只负责把当前可见工具投影为 `tools.<name>()` binding。每次 binding 调用都
 * 回到注册表 execute，因此审批、守卫、沙箱、审计与 spill 不存在第二条绕行路径。
 *
 * ## `allowed`：按会话判定这个工具是否可用
 *
 * `run_code` 是**创造模式**的标志能力（docs/30 §6）：标准模式下它不该出现。
 * 但工具注册是**进程级**的一次挂载，而模式是**会话级**的（同一进程里可以有
 * 一个创造模式会话和一个标准会话），所以不能用全局 `restrict`。
 *
 * 传进来的谓词拿到当前 `scope`，返回 false 时**这条调用被拒绝并给出原因**——
 * 不是静默失败，否则模型会反复重试同一个调用。
 */
export function createCodeTool(input: {
  readonly runtime: CodeRuntime
  readonly tools: ToolRegistry
  /**
   * 这条调用是否被允许；省略 = 总是允许。
   * 拿到的是执行 scope（含 `sessionId`），返回 false 时拒绝并说明原因。
   */
  readonly allowed?: ((scope: unknown) => boolean) | undefined
}): ToolDefinition<RunCodeInput, JsonValue> {
  return {
    name: 'run_code',
    description: '在受限代码运行器中执行 JavaScript；用 await tools.<工具名>(参数) 调用当前可见工具。每个工具调用仍会逐项走权限与审批。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript 程序；可使用 await tools.<name>(args)' },
        language: { type: 'string', description: '代码语言；当前仅 javascript', enum: ['javascript'] },
      },
      required: ['code'],
    },
    card: 'generic',
    timeoutMs: 60_000,
    async execute(call, opts) {
      if (input.allowed !== undefined && !input.allowed(opts.scope)) {
        /*
         * **抛出而不是返回 `{ ok:false }`**：`execute` 的返回值会被注册表当成
         * "工具成功返回了一个对象"，外层看到的是 `ok: true` + 一个带 error 字段的
         * value（实测确认）。抛结构化错误才会让引擎把它记成 `tool/result.isError`，
         * 界面上也才会显示成红色的失败卡片。
         */
        throw Object.assign(
          new Error('当前是「标准模式」，没有代码运行器。需要写脚本或造插件时，请新建一个「创造模式」会话。'),
          { code: 'EC-INVALID_PARAMS' },
        )
      }
      const visible = input.tools.schemas().filter((schema) => schema.name !== 'run_code')
      const result = await input.runtime.run({
        program: call.parsed.code,
        language: call.parsed.language ?? 'javascript',
        bindings: [{ global: 'tools', functions: visible.map((schema) => schema.name) }],
        signal: opts.signal,
        timeoutMs: 60_000,
        async invoke(binding, args) {
          const name = binding.startsWith('tools.') ? binding.slice('tools.'.length) : ''
          if (name === '' || !visible.some((schema) => schema.name === name)) throw Object.assign(new Error(`未声明的工具 binding：${binding}`), { code: 'CODE_BINDING_DENIED' })
          const child = await input.tools.execute({ callId: `code-${randomUUID()}`, name, arguments: JSON.stringify(args) }, { signal: opts.signal, ...(opts.scope === undefined ? {} : { scope: opts.scope }) })
          if (!child.ok) throw Object.assign(new Error(child.error?.code ?? '工具调用失败'), { code: child.error?.code ?? 'CODE_TOOL_FAILED' })
          return child.value ?? null
        },
      })
      return { ok: result.error === undefined, ...(result.value === undefined ? {} : { result: result.value }), logs: [...result.logs], ...(result.error === undefined ? {} : { error: result.error }) }
    },
  }
}
