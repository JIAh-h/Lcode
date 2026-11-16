import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@lcode/context'
import type { SessionService } from '@lcode/session'
import type { Disposer } from '@lcode/util'

/**
 * Agent 预设的全局默认值（本机设置）。
 *
 * 与权限预设正交：预设决定"Agent 用哪些工具、怎么工作"，权限决定"能碰什么"。
 *
 * | 预设 | 工具集 | 用途 |
 * |---|---|---|
 * | `standard` | 读写 / 命令 / 搜索 / 技能 / 子代理 | 日常任务 |
 * | `creator` | 标准 + `run_code` 代码运行器 | 写脚本、组合工具、造技能与插件 |
 *
 * **`creator` 之前是占位**：它需要一套"怎么造插件"的规范，否则模型有运行器却没有标准，
 * 造出来的东西装不上。规范已由 `lcode-plugin-creator` 技能承载（docs/30 §6），
 * 因此现在放开选择。
 */
export type AgentPresetId = 'standard' | 'creator'

/** 当前允许用户选择的预设。 */
export const SELECTABLE_AGENT_PRESETS: readonly AgentPresetId[] = ['standard', 'creator']

export interface AgentPresetSnapshot {
  readonly preset: AgentPresetId
  readonly source: 'default' | 'user'
  readonly changedAt?: number | undefined
}

export interface AgentPresetSettingService {
  get(): AgentPresetId
  snapshot(): AgentPresetSnapshot
  set(preset: AgentPresetId): Promise<AgentPresetSnapshot>
  watch(fn: (preset: AgentPresetId) => void): () => void
}

export interface LocalAgentPresetSettingOptions {
  readonly home: string
  readonly now?: (() => number) | undefined
}

interface PersistedAgentPreset {
  readonly version: 1
  readonly preset: string
  readonly changedAt: number
}

const DEFAULT_PRESET: AgentPresetId = 'standard'

function isSelectable(value: unknown): value is AgentPresetId {
  return typeof value === 'string' && (SELECTABLE_AGENT_PRESETS as readonly string[]).includes(value)
}

export function createLocalAgentPresetSetting(options: LocalAgentPresetSettingOptions): AgentPresetSettingService {
  const file = join(options.home, 'agent-preset.json')
  const now = options.now ?? (() => Date.now())
  let state = load(file)
  const watchers = new Set<(preset: AgentPresetId) => void>()

  return {
    get: () => state.preset,
    snapshot: () => state,
    async set(preset) {
      if (!isSelectable(preset)) throw new Error('这个 Agent 预设尚未开放')
      if (preset === state.preset) return state
      const next: PersistedAgentPreset = { version: 1, preset, changedAt: now() }
      persist(file, next)
      state = { preset, source: 'user', changedAt: next.changedAt }
      for (const watcher of watchers) watcher(preset)
      return state
    },
    watch(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
  }
}

function load(file: string): AgentPresetSnapshot {
  if (!existsSync(file)) return { preset: DEFAULT_PRESET, source: 'default' }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedAgentPreset>
    if (value.version !== 1 || !isSelectable(value.preset) || typeof value.changedAt !== 'number') {
      return { preset: DEFAULT_PRESET, source: 'default' }
    }
    return { preset: value.preset, source: 'user', changedAt: value.changedAt }
  } catch {
    return { preset: DEFAULT_PRESET, source: 'default' }
  }
}

function persist(file: string, value: PersistedAgentPreset): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    agentPreset: AgentPresetSettingService
    /** 会话级预设（创建时确定、不可变）；与全局默认值 `agentPreset` 是两件事 */
    sessionPreset: SessionPresetService
  }
}

/**
 * 会话级的 Agent 预设（docs/30 §6）。
 *
 * ## 与 `AgentPresetSettingService` 的分工
 *
 * | | 谁决定 | 可否变 |
 * |---|---|---|
 * | 全局设置（`agentPreset.json`） | 设置页「Agent 预设」 | 可随时改 |
 * | **会话预设**（`session/preset` 事件） | 新建会话时读全局设置，用户可当场覆盖 | **创建后不可变** |
 *
 * 分开的理由：模式决定工具集。中途切换会让同一会话里 `run_code` 时有时无，
 * 模型看到工具消失会反复重试。所以"这个会话用哪套工具"必须在创建时钉死，
 * 而"下次新建默认用哪个"才是可随时改的设置。
 */
export interface SessionPresetService {
  /** 读会话的预设；没有记录时按 `standard`（老会话在引入这个事件之前就存在） */
  presetOf(sessionId: string): AgentPresetId
  /** 创建会话时写入；重复写同一会话视为无操作（不可变） */
  setPreset(sessionId: string, preset: AgentPresetId, source: 'user' | 'default'): void
}

export function registerSessionPresets(input: {
  readonly ctx: Context
  readonly getSession: (sessionId: string) => SessionService
}): { readonly service: SessionPresetService; readonly dispose: Disposer } {
  const service: SessionPresetService = {
    presetOf(sessionId) {
      try {
        const events = input.getSession(sessionId).events()
        // 取**最后一条**：正常情况下只会有一条（不可变），最后一次读是为了容错
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type === 'session/preset') return event.data.preset
        }
      } catch {
        // 会话不可用：按标准模式处理，不因查不到而放大成异常
      }
      return 'standard'
    },
    setPreset(sessionId, preset, source) {
      const session = input.getSession(sessionId)
      // 不可变：已经有记录就不再写，避免同一会话出现两条互相矛盾的预设
      const existing = session.events().some((event) => event.type === 'session/preset')
      if (existing) return
      session.append({ type: 'session/preset', data: { preset, source } })
    },
  }

  /*
   * 提示层：从工具清单里**去掉** `run_code`（标准模式）。
   *
   * 用 `systemPrompt.tools()` 的过滤链——它是**会话级**的（回调拿到 promptCtx.sessionId），
   * 正是 Router 白名单用的同一个机制。
   *
   * 为什么不用 `tools.restrict`：那是全局可见集快照，而 `codeRuntime` 在装配早期挂载，
   * 彼时 web/lsp 还没注册，快照会把它们一起挡掉（实测 `web_fetch` 消失）。
   *
   * 注意：这一层只决定"**告诉模型**有哪些工具"。执行期还有一道
   * （`createCodeTool` 的 `allowed`），因为工具执行按名字全量解析，不读这个清单。
   */
  const unregisterPromptTools = input.ctx.get('systemPrompt').tools((all, promptCtx) => {
    const sessionId = promptCtx.sessionId
    if (sessionId === undefined) return all
    if (service.presetOf(sessionId) === 'creator') return all
    return all.filter((tool) => tool.name !== 'run_code')
  })

  /*
   * 创造模式的**创作指导**（docs/30 §6，对齐 DSH 的 "preset 创作指导"）。
   *
   * 为什么由模式自带、而不是让用户去加载技能：
   * 创造模式的全部意义就是"造东西"。用户选了它就该直接拿到规范——
   * 让模型自己想起加载 `lcode-plugin-creator` 是多余一步，而且它多半想不起来。
   *
   * 体积控制：这里只放**判据与红线**，详细的 API / 清单在技能里按需加载。
   * 把整份 skill 塞进系统提示词会让每一步都多付这些 token。
   */
  const CREATOR_GUIDE = [
    '## 创造模式',
    '',
    '这个会话可以**制造可安装的扩展**，而不只是改代码：',
    '',
    '- **插件**：加工具、注入提示词、监听事件。用 `run_code` 写，按 `lcode-plugin-creator` 技能的规范打包。',
    '- **技能**：把重复流程固化成 SKILL.md（用户级 `~/.lcode/skills/`，项目级 `<workspace>/.lcode/skills/`）。',
    '',
    '**先判断形态**：只需"一套提示词/流程"就造技能；要执行代码（读文件、跑命令、联网）才造插件。',
    '',
    '**四条红线**（违反任一条都装不上）：',
    '1. `lcode.json` 的 `contributes` 必须列出你注册的每一项；',
    '2. 注册写在 `activate()` 里，不能放在模块顶层；',
    '3. 自己创建的资源（定时器、子进程、watcher）必须返回 disposer；',
    '4. `entry` 必须指向能在纯 Node 下 `import()` 的 JS，不能是 TS 源码。',
    '',
    '**不要声称"能用了"**：装进 `~/.lcode/plugins/<id>/`、重启、确认工具出现在清单里，才算验证过。',
  ].join('\n')

  const unregisterGuide = input.ctx.get('systemPrompt').context(
    'creator-guide',
    ({ sessionId }) => (sessionId !== undefined && service.presetOf(sessionId) === 'creator' ? CREATOR_GUIDE : ''),
    /*
     * order 450：在记忆（850）之前、人设（0）之后。它属于"这一轮怎么做"的说明，
     * 不是每轮变化的状态，所以**不标 volatile**——标了会让它每步都进消息尾部，
     * 反而破坏前缀稳定。
     */
    { order: 450 },
  )

  return {
    service,
    dispose() {
      unregisterPromptTools()
      unregisterGuide()
    },
  }
}
