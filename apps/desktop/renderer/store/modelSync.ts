import { findModel, setDefaultModel, setModels } from './uiPrefs.ts'

/**
 * **主进程是模型配置的唯一真相**，这里负责两件事：
 *
 * 1. 把主进程的清单与默认选择**同步进**渲染层镜像（`uiPrefs`）
 * 2. 把用户在输入区/设置页做的选择**回写**主进程（`model.setDefault`）
 *
 * ## 为什么需要这个模块（两个真实踩过的坑）
 *
 * **坑一**：这段同步原来写在**设置页**的 `refresh()` 里。后果：启动后首页与输入区的
 * 模型菜单读的是 `uiPrefs` 的初始值（当时是两条硬编码的假模型），**只有进过设置页**
 * 才会被真实清单覆盖——"点开设置再返回才对"。
 * 根因不是那段逻辑写错了，而是**它被放在了错误的地方**：模型清单是**全应用共用**的
 * 状态，却被一个**单个页面**负责初始化。现在移到应用根部（`App`），与路由无关。
 *
 * **坑二（更隐蔽）**：回写这一步**曾经根本不存在**。输入区的模型菜单只改了 `uiPrefs`
 * 这个渲染层镜像，主进程侧的 `ctx.agentDefaultModel` 从头到尾是空的——于是用户
 * "选好了模型"，一发消息却收到「还没有选择模型」。界面看上去一切正常，
 * 因为镜像确实变了。**镜像变了不等于真相变了**，而这个模块的职责正是让两者一致。
 *
 * ## 失败不抛错
 *
 * 拿不到桥（浏览器预览）或 IPC 失败时**静默保持原状**：模型菜单空着是诚实的，
 * 而抛错会让首页白屏。真正的失败原因由设置页显示（那里是用户会去看的地方）。
 */

interface ModelBridgeLike {
  list(): Promise<{
    providers: readonly string[]
    custom: readonly {
      readonly name: string
      readonly label: string
      readonly model: string
      readonly base_url: string
    }[]
  }>
  getDefault(): Promise<{ readonly provider: string; readonly model: string } | null>
  setDefault(input: { readonly provider: string; readonly model: string }): Promise<unknown>
  limits(input: { readonly provider: string; readonly model: string }): Promise<unknown>
}

function bridge(): ModelBridgeLike | undefined {
  return (globalThis as unknown as { lcode?: { model?: ModelBridgeLike } }).lcode?.model
}

/** 同一进程内只同步一次（多个组件挂载时不重复打 IPC） */
let inflight: Promise<void> | null = null

/**
 * 把主进程的模型清单同步进渲染层镜像。
 *
 * 幂等：并发调用共用同一次请求；已完成后再次调用直接返回。
 * `force` 用于设置页保存/删除后主动刷新。
 */
export function syncModelsFromMain(options: { readonly force?: boolean } = {}): Promise<void> {
  if (inflight !== null && options.force !== true) return inflight
  inflight = (async () => {
    const api = bridge()
    if (api === undefined) return
    try {
      const [list, current] = await Promise.all([api.list(), api.getDefault()])
      // 镜像只保留渲染层需要的四项（name / src / baseUrl / model）
      setModels(
        list.custom.map((m) => ({
          name: m.name,
          src: m.label,
          baseUrl: m.base_url,
          model: m.model,
        })),
      )
      // 主进程侧的默认选择是权威；它为空时 setModels 已经回落到第一个。
      // 传 model 是为了让镜像与真相完全一致（同一个 provider 可能换过模型 id）。
      if (current !== null && current.provider !== '') {
        setDefaultModel(current.provider, current.model)
      }
    } catch {
      // 静默：首页不该因为模型列表拉不到而白屏（设置页会显示原因）
    }
  })()
  return inflight
}

/**
 * 模型是否能读图片的**兜底**判断。
 *
 * 权威来源是供应商元数据（`resolveModelVision`）；但部分网关什么模态字段都不给，
 * 此时按模型 id 的家族命名判断；embedding / rerank / 生成类模型明确排除。
 * 未知不当作不支持，避免把本来能读图的模型误挡在粘贴之外。
 */
export function modelSupportsImages(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (id === '') return false
  if (/embedding|rerank|video-generation|image-generation/.test(id)) return false
  return /(^|[/_.-])(vl|vision|omni)([/\d_.-]|$)|deepseek.*(flash|vl|vision)|gpt-4o|gpt-4\.1|gpt-5|claude-(3|4)|gemini|glm-4v|pixtral|llava|internvl|step-1v|yi-vision|grok-(2|3|4)/.test(id)
}

const visionCache = new Map<string, boolean>()

/**
 * 问供应商这个模型是否声明了图片输入。
 *
 * 官方 DeepSeek 的 `/models` 给 `input_modalities`，百炼原生目录给
 * `inference_metadata.request_modality`；没有字段时返回 undefined，
 * 调用方再回落到模型名判断——不把“未知”当成“不支持”。
 */
export async function resolveModelVision(provider: string, model: string): Promise<boolean | undefined> {
  if (provider === '' || model === '') return undefined
  const key = `${provider}:${model}`
  const cached = visionCache.get(key)
  if (cached !== undefined) return cached
  const bridge = (globalThis as unknown as { lcode?: { model?: ModelBridgeLike } }).lcode?.model
  if (bridge === undefined || typeof bridge.limits !== 'function') return undefined
  try {
    const limits = await bridge.limits({ provider, model }) as { readonly vision?: unknown } | undefined
    if (typeof limits?.vision !== 'boolean') return undefined
    visionCache.set(key, limits.vision)
    return limits.vision
  } catch {
    return undefined
  }
}

/**
 * 选默认模型：**先写主进程，再改镜像**。
 *
 * 顺序刻意如此——主进程是权威，镜像只是它的影子。写失败了（没有桥、IPC 报错）
 * 就不该让界面显示一个"其实没生效"的选择，否则用户会用上一个和他以为的不一样的模型，
 * 而那种偏差没有任何提示会告诉他。
 *
 * 入参是**配置条目的 id**（`uiPrefs.models[].name`），服务端模型 id 由这里查。
 */
export async function chooseDefaultModel(providerName: string): Promise<void> {
  const entry = findModel(providerName)
  if (entry === undefined) return
  const api = bridge()
  if (api === undefined) return
  await api.setDefault({ provider: entry.name, model: entry.model })
  setDefaultModel(entry.name, entry.model)
}
