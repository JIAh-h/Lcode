import type { PluginInfo } from '@lcode/plugin-registry'
import type { ToolDefinition } from '@lcode/tools'

/**
 * 让模型能把**自己刚写的插件**真正装上（docs/30 §6）。
 *
 * ## 为什么必须有这个工具
 *
 * 创造模式让模型具备"造插件"的能力，但造出来的东西要能被应用识别，
 * 必须走安装器：校验 manifest/入口、复制快照、登记到 `plugins` 表。
 * 只把文件 write 进 `~/.lcode/plugins/` 是**无效**的——没有登记记录，
 * 应用不加载，而用户会以为装好了。
 *
 * 之前的实测就是这样：模型造完插件后说"我无法写入磁盘"，或者写进去了
 * 但界面上什么都没有。根因不是权限，是**缺这个入口**。
 *
 * ## 为什么安装在"源目录"而不是直接写目标目录
 *
 * 安装器会 `snapshotDirectory(source → staging)` 做一次快照并算哈希，
 * 所以源目录可以是任意位置（工作区里的一个文件夹、临时目录都行）。
 * 这样模型的工作流是自然的：**在普通目录里写代码 → 调这个工具安装**，
 * 而不是去猜 `~/.lcode/plugins/<id>/<version>/` 这种内部布局。
 */
export interface PluginInstallDeps {
  /** 安装并返回结果；由 runtime 注入，内部走 registry.install */
  readonly install: (path: string) => Promise<{ readonly id: string; readonly version: string; readonly hash: string }>
  /** 已安装清单，用于"装完确认"与重名提示 */
  readonly list: () => readonly PluginInfo[]
  /** 当前会话的工作区；无工作区时用于把相对路径解析到 home 下 */
  readonly workspaceOf: (sessionId: string) => string | undefined
  readonly home: string
}

export function createPluginInstallTool(deps: PluginInstallDeps): ToolDefinition {
  return {
    name: 'plugin_install',
    description:
      '把**已经写好**的插件目录安装进 Lcode，使其可被启用与加载。\n' +
      '插件目录必须包含 `lcode.json`（清单）、`package.json`（含 "type": "module"）与清单里 `entry` 指向的入口文件。\n' +
      '安装会校验这些文件并复制一份快照——**直接往 `~/.lcode/plugins/` 里写文件是无效的**，必须经过本工具。\n' +
      '安装成功后还需要启用（`plugin_activate`）才能加载。',
    card: 'generic',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '插件目录的路径（相对会话工作区，或绝对路径）',
        },
        activate: {
          type: 'boolean',
          description: '安装后立即启用（默认 true）',
        },
      },
      required: ['path'],
    },
    describeAction: (parsed) => {
      const p = parsed as { path?: string }
      /*
       * **不声明 paths**（docs/30 §6）。
       *
       * 声明了就会进工作区边界判定：无工作区会话里"边界未知"必须按最保守
       * 处理 → ET-DENIED，而安装插件本来就是往**应用自己的目录**里写，
       * 与工作区边界无关（实测踩过：加上 paths 后整条链路直接拒绝）。
       *
       * 真正的写权限由安装器自己保证：它只写 `~/.lcode/plugins/` 下的快照，
       * 源目录只读。
       */
      return { summary: `安装插件：${p.path ?? ''}` }
    },
    execute: async (call, opts) => {
      const p = call.parsed as { path?: unknown; activate?: unknown }
      const raw = typeof p.path === 'string' ? p.path.trim() : ''
      if (raw === '') {
        return { ok: false, error: { code: 'EC-INVALID_PARAMS', message: 'path 不能为空' } }
      }
      // 相对路径按会话工作区解析；无工作区就按 home 解析（模型可能写在 home 下的临时目录）
      const sessionId = typeof opts.scope === 'object' && opts.scope !== null
        ? (opts.scope as { readonly sessionId?: unknown }).sessionId
        : undefined
      const base = (typeof sessionId === 'string' ? deps.workspaceOf(sessionId) : undefined) ?? deps.home
      const resolved = /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw : `${base}/${raw}`

      try {
        const result = await deps.install(resolved)
        return {
          ok: true,
          value: {
            installed: { id: result.id, version: result.version },
            path: resolved,
            next:
              p.activate === false
                ? '已安装但未启用。用户可在「设置 → 插件」里启用，或让我继续启用。'
                : '已安装。请在「设置 → 插件」确认状态为可用。',
          },
        }
      } catch (error) {
        // 安装器的报错已经写明具体原因（manifest 非法 / 入口缺失 / 版本不兼容），
        // 原样透出，模型才改得对。
        return {
          ok: false,
          error: {
            code: 'EC-VALIDATION_FAILED',
            message: `插件安装失败：${error instanceof Error ? error.message : String(error)}`,
          },
        }
      }
    },
  }
}

export { createPluginVerifyTool, type PluginVerifyDeps, type VerifyChecks } from './verify.ts'
export { createVerifySandbox, type VerifySandbox } from './sandbox.ts'
