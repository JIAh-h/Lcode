import type { CodeRuntime, JsonValue } from '@lcode/code-runtime'
import type { ToolDefinition, ToolRegistry } from '@lcode/tools'
import { randomUUID } from 'node:crypto'

interface RunCodeInput { readonly code: string; readonly language?: 'javascript' | undefined }

/**
 * Consumer 只负责把当前可见工具投影为 `tools.<name>()` binding。每次 binding 调用都
 * 回到注册表 execute，因此审批、守卫、沙箱、审计与 spill 不存在第二条绕行路径。
 */
export function createCodeTool(input: { readonly runtime: CodeRuntime; readonly tools: ToolRegistry }): ToolDefinition<RunCodeInput, JsonValue> {
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
