import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentRuntime } from './agent-runtime.ts'
import type { VerifyChecks } from '@lcode/tool-plugin'

/**
 * 在**一次性隔离环境**里验证插件（docs/30 §6）。
 *
 * 对齐 DSH 的 `dsh plugin --profile <scratch> add …`：起一个全新的、用完就删的
 * 运行环境，而不是在用户的真实运行时里试。DSH 的验证矩阵（§8.4）明确要求
 * "全新临时 DSH_HOME / profile"，理由这里同样成立：
 *
 * 1. 失败的插件不该留在用户的 `plugins/` 目录与 `plugins` 表里；
 * 2. 会抛错的插件不该污染当前会话的工具清单与提示词；
 * 3. "在我这台机器、带着既有状态试过"不等于"用户装了就能用"。
 *
 * ## 为什么放这里而不是 tool-plugin 包
 *
 * 验证要 `createAgentRuntime`（新建一整套服务、装配、会话），而
 * `tool-plugin` 是它的下游依赖——放进去会形成环。
 */
export async function verifyPluginInSandbox(input: {
  readonly path: string
  /** 用户真实 home：只用于取"内置技能目录"等只读资源，不写 */
  readonly realHome: string
  readonly builtinSkillsDir?: string | undefined
}): Promise<VerifyChecks> {
  const home = await mkdtemp(join(tmpdir(), 'lcode-plugin-verify-'))
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined
  try {
    /*
     * 不传 services：`createAgentRuntime({ home })` 会**自建一整套服务**
     * （ownsServices = true），与主进程完全隔离。传了 services 就会复用
     * 用户真实的 ctx——那等于没隔离。
     */
    runtime = await createAgentRuntime({
      home,
      ...(input.builtinSkillsDir === undefined ? {} : { builtinSkillsDir: input.builtinSkillsDir }),
    })

    // 1. 装进隔离环境（失败 = 包不合法，直接把安装器的话透出）
    const installed = await runtime.plugins.installLocal(input.path)
    // facade 的 list() 不接受参数：隔离环境里本来就没有内置插件记录
    const manifest = runtime.plugins.list().find((item) => item.id === installed.id)

    // 2. 启用：host 侧注册（工具/提示段）都发生在这一步
    let activationError: string | undefined
    let environmentError: string | undefined
    try {
      await runtime.plugins.activate({ id: installed.id, version: installed.version })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      /*
       * **区分"插件写错了"和"环境起不来"**。
       *
       * 沙箱下 `electron.exe` 作为子进程无法启动（AppContainer 限制，见
       * docs/30 §9.3），此时任何 host 插件都会 `host/initialize` 超时——
       * 与插件代码无关。不区分的话，模型会拿着"激活失败"去反复改本来
       * 正确的代码，永远修不好。
       */
      if (/host\/initialize|EX-HOST_UNAVAILABLE|timed out/i.test(message)) {
        environmentError = message
      } else {
        activationError = message
      }
    }

    // 3. 断言：清单声明的 vs 工具表里实际出现的
    const declaredTools = [...(manifest?.contributes.tools ?? [])]
    const declaredPromptSections = [...(manifest?.contributes.promptSections ?? [])]
    const registeredTools = runtime.ctx.get('tools').schemas().map((schema) => schema.name)

    /*
     * 提示段无法从"装配后的 system"里精确反查 id（提示词是拼好的文本）。
     * 用激活后的 inspect 作为事实来源：它来自生命周期记录，未成功注册的
     * 提示段不会出现在那里。
     */
    const inspection = runtime.plugins.inspect().find((item) => item.id === installed.id)
    const registeredPromptSections = [...(inspection?.contributes.promptSections ?? [])]

    return {
      id: installed.id,
      version: installed.version,
      declaredTools,
      registeredTools: registeredTools.filter((name) => declaredTools.includes(name)),
      declaredPromptSections,
      registeredPromptSections,
      ...(activationError === undefined ? {} : { activationError }),
      ...(environmentError === undefined ? {} : { environmentError }),
    }
  } finally {
    // 无论成败都销毁：失败时更要不留痕迹
    await runtime?.dispose().catch(() => undefined)
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}
