import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 插件验证沙箱（docs/30 §6，对齐 DSH 的"全新临时 profile"做法）。
 *
 * ## 为什么必须在全新环境里验证
 *
 * 直接在用户的运行时里"装一下试试"有三个坏处：
 * 1. 失败的插件会留在用户的 `plugins/` 目录和 `plugins` 表里；
 * 2. 一个会抛错的插件可能污染当前会话的提示词/工具清单；
 * 3. 用户看到的"已验证"其实是"在我这台机器上、带着既有状态试过"。
 *
 * DSH 的做法是 `dsh plugin --profile <scratch> add … && dsh --profile <scratch> --dump-config`：
 * **起一个一次性的 profile，跑完就删**。这里用同样形状的实现——临时 Lcode Home。
 *
 * ## 边界
 *
 * 只验证**插件自身**：能不能装、能不能激活、声明的贡献项有没有真的出现。
 * 不验证"它和用户当前配置的交互"（那需要用户的真实环境，属于用户自己点了
 * 启用之后的事）。
 */
export interface VerifySandbox {
  readonly home: string
  readonly dispose: () => Promise<void>
}

/**
 * 建一个一次性的 Lcode Home。
 *
 * 放在系统临时目录而不是 `~/.lcode` 下：后者会被应用当作真实 home 加载，
 * 一次失败的验证就能让用户的插件表出现幽灵记录。
 */
export async function createVerifySandbox(prefix = 'lcode-plugin-verify-'): Promise<VerifySandbox> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  return {
    home,
    async dispose() {
      await rm(home, { recursive: true, force: true })
    },
  }
}
