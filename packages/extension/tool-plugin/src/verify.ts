import type { ToolDefinition } from '@lcode/tools'

/**
 * `plugin_verify`：在**一次性环境**里把插件装上、启用、断言贡献项，
 * 然后把具体问题报出来（docs/30 §6，对齐 DSH 的 scratch profile 验证）。
 *
 * ## 为什么这是独立工具而不是 `plugin_install` 的开关
 *
 * 两者的失败语义完全不同：
 * - `install` 失败 = 包不合法（manifest/入口/版本），用户要改代码；
 * - `verify` 失败 = **装上了但没生效**（注册项没出现、激活抛错），
 *   这属于"发布前必须自己发现"的问题。
 *
 * 合成一个动作会让模型分不清"是我写错了"还是"环境有问题"。
 *
 * ## 模型拿到的结果形状
 *
 * 验证结果是**可执行的事实清单**，不是"成功/失败"两个词：
 * 声明了哪些工具、实际出现了哪些、缺了哪些、激活是否抛错。
 * 只有这样模型才能自己修到通过。
 */
export interface VerifyChecks {
  /** 插件 id/version */
  readonly id: string
  readonly version: string
  /** 清单里声明要贡献的工具名 */
  readonly declaredTools: readonly string[]
  /** 在隔离环境里**实际**注册进工具表的工具名 */
  readonly registeredTools: readonly string[]
  /** 清单里声明的提示段 id */
  readonly declaredPromptSections: readonly string[]
  /** 实际出现的提示段 id（能从系统提示词里观察到的） */
  readonly registeredPromptSections: readonly string[]
  /** 激活阶段抛出的错误（属于**插件**的问题，模型应据此改代码） */
  readonly activationError?: string | undefined
  /**
   * 环境级失败（与插件无关）。
   *
   * 例如沙箱下 host 进程无法启动（docs/30 §9.3）：任何 host 插件都会这样，
   * 此时**不能让模型去改插件代码**——它改不好，因为问题不在它。
   * 单独列出来，验收结论才能说清"是环境的问题"。
   */
  readonly environmentError?: string | undefined
}

export interface PluginVerifyDeps {
  /**
   * 在一次性环境里跑一遍验证。
   *
   * 由 runtime 注入：它要新建一个**独立 home** 的 AgentRuntime
   * （`createAgentRuntime({ home })` 不传 services 会自建一整套），
   * 装机、启用、读工具表与提示词，最后销毁。工具层自己做不到这件事
   * （会形成 tool-plugin → lcode-desktop → tool-plugin 的环）。
   */
  readonly run: (input: { readonly path: string }) => Promise<VerifyChecks>
}

export function createPluginVerifyTool(deps: PluginVerifyDeps): ToolDefinition {
  return {
    name: 'plugin_verify',
    description:
      '在**一次性隔离环境**里验证插件是否真的能用：安装 → 启用 → 检查清单声明的工具/提示段是否真的注册成功。\n' +
      '不会污染当前环境（用临时 Lcode Home，跑完即删）。\n' +
      '返回声明项与实际出现项的差集——**缺了什么就是你要修的地方**。\n' +
      '造完插件后应当先跑这个，确认通过再交给用户。',
    card: 'generic',
    timeoutMs: 180_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '插件目录路径（相对会话工作区或绝对路径）' },
      },
      required: ['path'],
    },
    describeAction: (parsed) => {
      const p = parsed as { path?: string }
      // 与 install 同理：不声明 paths，避免被工作区边界判定拦下
      return { summary: `验证插件：${p.path ?? ''}` }
    },
    execute: async (call) => {
      const p = call.parsed as { path?: unknown }
      const path = typeof p.path === 'string' ? p.path.trim() : ''
      if (path === '') {
        return { ok: false, error: { code: 'EC-INVALID_PARAMS', message: 'path 不能为空' } }
      }
      try {
        const checks = await deps.run({ path })
        const missingTools = checks.declaredTools.filter((name) => !checks.registeredTools.includes(name))
        const missingSections = checks.declaredPromptSections.filter((name) => !checks.registeredPromptSections.includes(name))
        const problems = [
          ...(checks.activationError === undefined ? [] : [`激活失败：${checks.activationError}`]),
          ...(missingTools.length === 0 ? [] : [`以下工具声明了但没注册成功：${missingTools.join(', ')}`]),
          ...(missingSections.length === 0 ? [] : [`以下提示段声明了但没注入：${missingSections.join(', ')}`]),
        ]
        return {
          ok: true,
          value: {
            /*
             * 环境级失败时不算"通过"，但也要说清**不是插件的错**——
             * 模型据此应该停下并告知用户，而不是继续改代码。
             */
            passed: problems.length === 0 && checks.environmentError === undefined,
            inconclusive: checks.environmentError !== undefined,
            plugin: { id: checks.id, version: checks.version },
            // 转成普通数组：工具返回值必须是 JsonValue，readonly 数组不满足
            declared: { tools: [...checks.declaredTools], promptSections: [...checks.declaredPromptSections] },
            observed: { tools: [...checks.registeredTools], promptSections: [...checks.registeredPromptSections] },
            problems,
            ...(checks.environmentError === undefined
              ? {}
              : {
                  hint:
                    '当前环境无法启动插件的宿主进程（与插件代码无关）。' +
                    '请不要继续修改插件；把这一点告诉用户，并说明需要修复宿主启动环境后才能完成验证。' +
                    `原始错误：${checks.environmentError}`,
                }),
          },
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'EC-VALIDATION_FAILED',
            message: `验证过程中出错：${error instanceof Error ? error.message : String(error)}`,
          },
        }
      }
    },
  }
}
