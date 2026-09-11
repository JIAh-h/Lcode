import type { ScopeKey } from '@lcode/scope'
import type { Disposer } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import type { ToolRegistry, ToolSchema } from '@lcode/tools'

/**
 * SystemPromptService —— 提示词与工具 schema 装配（文档 20 §5.2）。
 * ctx key: `ctx.systemPrompt`。
 */
export interface SystemPromptService {
  /** 注册一个静态段落（返回 disposer） */
  section(id: string, content: string, opts?: { readonly order?: number; readonly scope?: ScopeKey }): Disposer
  /** 注册一个动态上下文（每次装配时求值；求值必须是纯函数且不得阻塞） */
  context(id: string, fn: (ctx: AssembleCtx) => string | Promise<string>, opts?: { readonly order?: number }): Disposer
  /** 声明变量的取值来源 */
  variable(name: string, resolve: (ctx: AssembleCtx) => string): Disposer
  /** 追加/收窄工具 schema（收窄是叠加的，不可放宽） */
  tools(ids: readonly string[] | ((all: readonly ToolSchema[]) => readonly ToolSchema[])): Disposer
  /** 装配（纯函数语义） */
  assemble(input: AssembleInput): Promise<AssembledPrompt>
}

export interface AssembleCtx {
  readonly variables: Readonly<Record<string, string>>
  readonly sessionId?: string
}

export interface AssembleInput {
  readonly variables?: Readonly<Record<string, string>>
  readonly sessionId?: string
}

export interface AssembledPrompt {
  readonly system: string
  readonly tools: readonly ToolSchema[]
}

interface SectionEntry {
  id: string
  content: string
  order: number
}

interface ContextEntry {
  id: string
  fn: (ctx: AssembleCtx) => string | Promise<string>
  order: number
}

/** 内存实现 */
export class InMemorySystemPromptService implements SystemPromptService {
  private sections = new Map<string, SectionEntry>()
  private contexts = new Map<string, ContextEntry>()
  private variables = new Map<string, (ctx: AssembleCtx) => string>()
  private toolOps: Array<{ order: number; apply: (all: readonly ToolSchema[]) => readonly ToolSchema[] }> = []
  private orderCounter = 0

  constructor(private readonly toolsRegistry: ToolRegistry) {}

  section(id: string, content: string, opts?: { readonly order?: number; readonly scope?: ScopeKey }): Disposer {
    void opts?.scope
    if (this.sections.has(id)) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_CONFLICT,
        message: `section 重复注册：${id}`,
        userMessage: '这个提示段落已经存在了。',
      })
    }
    this.sections.set(id, { id, content, order: opts?.order ?? this.orderCounter++ })
    const myEntry = this.sections.get(id)!
    return () => {
      if (this.sections.get(id) === myEntry) this.sections.delete(id)
    }
  }

  context(id: string, fn: (ctx: AssembleCtx) => string | Promise<string>, opts?: { readonly order?: number }): Disposer {
    this.contexts.set(id, { id, fn, order: opts?.order ?? this.orderCounter++ })
    const myEntry = this.contexts.get(id)!
    return () => {
      if (this.contexts.get(id) === myEntry) this.contexts.delete(id)
    }
  }

  variable(name: string, resolve: (ctx: AssembleCtx) => string): Disposer {
    this.variables.set(name, resolve)
    return () => {
      this.variables.delete(name)
    }
  }

  tools(ids: readonly string[] | ((all: readonly ToolSchema[]) => readonly ToolSchema[])): Disposer {
    const apply =
      typeof ids === 'function'
        ? ids
        : (all: readonly ToolSchema[]): readonly ToolSchema[] => all.filter((s) => (ids as readonly string[]).includes(s.name))
    this.toolOps.push({ order: this.orderCounter++, apply })
    const idx = this.toolOps.length - 1
    return () => {
      this.toolOps[idx] = undefined as unknown as { order: number; apply: (all: readonly ToolSchema[]) => readonly ToolSchema[] }
    }
  }

  async assemble(input: AssembleInput): Promise<AssembledPrompt> {
    // 变量解析（取值来源声明 → 装配时求值）
    const resolved: Record<string, string> = { ...(input.variables ?? {}) }
    const ctx: AssembleCtx = { variables: resolved, sessionId: input.sessionId }
    for (const [name, resolve] of this.variables) {
      resolved[name] = resolve(ctx)
    }

    // 段落按 (order, 注册顺序) 稳定排序（P2）
    const sections = [...this.sections.values()].sort((a, b) => a.order - b.order || 0)
    let system = sections.map((s) => s.content).join('\n\n')

    // 动态上下文（P3：求值不得有副作用——调用方责任，这里只按序追加）
    const contexts = [...this.contexts.values()].sort((a, b) => a.order - b.order || 0)
    const dynamicParts: string[] = []
    for (const entry of contexts) {
      dynamicParts.push(await entry.fn(ctx))
    }
    if (dynamicParts.length > 0) {
      system = [system, ...dynamicParts].filter((s) => s.length > 0).join('\n\n')
    }

    // 变量插值（{{name}} 字面替换）
    system = system.replace(/\{\{(\w+)\}\}/g, (_, name: string) => resolved[name] ?? '')

    // 工具 schema：从注册表全量开始，逐层收窄（P4：只可收窄不可放宽）
    let all: readonly ToolSchema[] = this.toolsRegistry.schemas()
    const ops = [...this.toolOps].sort((a, b) => a.order - b.order || 0)
    for (const op of ops) {
      if (!op) continue
      const narrowed = op.apply(all)
      // 校验收窄：结果必须是输入的子集（P4）
      const inputIds = new Set(all.map((s) => s.name))
      for (const s of narrowed) {
        if (!inputIds.has(s.name)) {
          throw new LcodeErrorImpl({
            code: ERROR_CODES.EC_VALIDATION_FAILED,
            message: `工具收窄违规：${s.name} 不在可见集合内（P4：只可收窄不可放宽）`,
            userMessage: '这项配置不对，请检查后再保存。',
          })
        }
      }
      all = narrowed
    }

    return { system, tools: all }
  }
}

export function createSystemPromptService(toolsRegistry: ToolRegistry): SystemPromptService {
  return new InMemorySystemPromptService(toolsRegistry)
}
