import { useSyncExternalStore } from 'react'

/**
 * UI 偏好：模型选择与权限预设的**单一真相**（骨架阶段的内存实现）。
 *
 * ⚠️ 为什么要有这个模块：文档 D20 明确「一份状态只有一个主人」——
 * 首页 composer、工作台 composer、设置页三处都要读写"当前用哪个模型"，
 * 若各自维护副本必然互相覆盖。这里先把三处收敛到一份状态，
 * 将来接 `ctx.agentDefaultModel`（文档 18 §3）时只替换本模块的实现即可。
 *
 * 同理，权限预设收敛到一处（文档 12 §3.3）。
 */

export interface ModelEntry {
  readonly name: string
  /** 供应商标识（自定义 / DeepSeek / OpenAI / Ollama（本地）） */
  readonly src: string
  /**
   * 解析后的接口地址（文档 18 的 `baseUrl`）。
   * 内置供应商来自适配器默认值（L5），自定义来自用户填写。
   */
  readonly baseUrl: string
  /**
   * 这个供应商**当前要用的服务端模型 id**（如 `deepseek-chat`）。
   *
   * 与 `name` 是两件事：`name` 是配置条目的 id（默认模型选择里传的 `provider`），
   * 而 `model` 才是请求体里那个字段。两者混用会让引擎发一个服务端不认的模型名。
   */
  readonly model: string
}

/** 权限预设：产品层字面量，写死在文档 12 §3.3 与 UI 中（底层是两条轴的打包） */
export const PERMISSION_PRESETS = ['只读', '标准', '自动', '完全访问', '无人值守'] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/** 权限预设的用户预期（文档 12 §3.3 表格原文，用于菜单里的说明行） */
export const PERMISSION_PRESET_HINT: Readonly<Record<PermissionPreset, string>> = {
  只读: '它只能看，不能改',
  标准: '能改我的项目，动手前问我',
  自动: '工作区内自己干，不打扰我',
  完全访问: '哪里都能碰，但动手前问我',
  无人值守: '用于自动化，不打扰我',
}

export interface UiPrefs {
  readonly models: readonly ModelEntry[]
  /** 默认模型的**供应商标识**（`ModelEntry.name`）；空串 = 还没选 */
  readonly defaultProvider: string
  /**
   * 默认模型的**服务端模型 id**，与 `defaultProvider` 一起构成一次完整的
   * `ctx.agentDefaultModel` 选择（文档 18 §3.1：选择入口的唯一权威在主进程）。
   */
  readonly defaultModel: string
  readonly permissionPreset: PermissionPreset
}

const INITIAL: UiPrefs = {
  /*
   * **空数组，不预置任何模型。**
   *
   * 这里原来硬编码了两条 DeepSeek 模型——那是**假数据**。后果：用户一个模型都没配，
   * 首页与输入区的模型菜单却已经列着两个不存在的模型；只有进过设置页
   * （触发一次 IPC 同步）才会被真实清单覆盖。
   *
   * 真相只有一个：主进程（`model.list`）。这里只做它的**镜像**，
   * 而镜像在拿到数据前必须是空的——"空"是诚实的，"两个假模型"不是。
   */
  models: [],
  /** 空串 = 还没选；拿到清单后由 `syncModelsFromMain()` 按主进程的设置回填 */
  defaultProvider: '',
  defaultModel: '',
  permissionPreset: '标准',
}

let state: UiPrefs = INITIAL
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): UiPrefs {
  return state
}

/** 当前偏好（非 React 环境也可用） */
export function getUiPrefs(): UiPrefs {
  return state
}

/** 按配置条目的 id 找一条模型 */
export function findModel(name: string): ModelEntry | undefined {
  return state.models.find((m) => m.name === name)
}

/**
 * 选默认模型。
 *
 * 传**配置条目的 id**（`ModelEntry.name`），不是显示名也不是服务端模型 id——
 * 调用方从菜单里拿到的就是它。服务端 id 由这里从清单里查出来，所以调用方
 * 不需要、也不该自己拼一个模型名（那正是"显式名当模型名发出去"那个 bug 的入口）。
 */
export function setDefaultModel(providerName: string, modelId?: string): void {
  const entry = state.models.find((m) => m.name === providerName)
  const model = modelId ?? entry?.model ?? providerName
  if (state.defaultProvider === providerName && state.defaultModel === model) return
  state = { ...state, defaultProvider: providerName, defaultModel: model }
  emit()
}

export function setPermissionPreset(preset: PermissionPreset): void {
  if (state.permissionPreset === preset) return
  state = { ...state, permissionPreset: preset }
  emit()
}

export function setModels(models: readonly ModelEntry[]): void {
  // 默认模型被删掉时回落到第一个，避免"指向不存在的模型"
  const stillExists = models.some((m) => m.name === state.defaultProvider)
  if (stillExists) {
    // 配置可能改了模型 id（编辑过），镜像跟着更新，避免选中项停留在一个旧 id 上
    const entry = models.find((m) => m.name === state.defaultProvider)
    state = { ...state, models, defaultModel: entry?.model ?? state.defaultModel }
  } else {
    const first = models[0]
    state = { ...state, models, defaultProvider: first?.name ?? '', defaultModel: first?.model ?? '' }
  }
  emit()
}

/** React 绑定：任一偏好变化都会触发重渲染 */
export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
