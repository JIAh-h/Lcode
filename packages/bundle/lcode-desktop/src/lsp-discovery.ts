import { existsSync } from 'node:fs'
import type { LspServerDef } from '@lcode/lsp-local'

/**
 * 自动发现本机语言服务器：只在 PATH 里找到可执行文件时才注册。
 * - TS/JS 由主进程单独补（随包分发），不在这里。
 * - Windows 跳过 `.cmd`/`.bat`：SubprocessService 不经过 shell，直接 spawn 脚本 shim 会失败。
 * - 找不到不报错；`lsp_query` 缺失时才给出安装命令。
 */
const AUTO_LSP_CANDIDATES: readonly {
  readonly language: string
  readonly candidates: readonly { readonly command: string; readonly args?: readonly string[] }[]
}[] = [
  { language: 'rust', candidates: [{ command: 'rust-analyzer' }] },
  { language: 'go', candidates: [{ command: 'gopls' }] },
  { language: 'python', candidates: [{ command: 'pylsp' }, { command: 'pyright-langserver', args: ['--stdio'] }] },
  { language: 'c', candidates: [{ command: 'clangd' }] },
  { language: 'cpp', candidates: [{ command: 'clangd' }] },
  { language: 'lua', candidates: [{ command: 'lua-language-server' }] },
  { language: 'bash', candidates: [{ command: 'bash-language-server', args: ['start'] }] },
]

export interface DiscoverLspOptions {
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: NodeJS.Platform | undefined
  /** 测试注入；默认 existsSync */
  readonly exists?: ((path: string) => boolean) | undefined
}

export function findExecutable(command: string, options: DiscoverLspOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  if (command.includes('/') || command.includes('\\')) return exists(command) ? command : undefined
  const pathSeparator = platform === 'win32' ? ';' : ':'
  const fileSeparator = platform === 'win32' ? '\\' : '/'
  const dirs = (env.PATH ?? '').split(pathSeparator).filter((dir) => dir !== '')
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext !== '')
    : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const base = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir
      const candidate = `${base}${fileSeparator}${command}${extension}`
      if (!exists(candidate)) continue
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) continue
      return candidate
    }
  }
  return undefined
}

export function discoverAutoLspServers(options: DiscoverLspOptions = {}): Record<string, LspServerDef> {
  const servers: Record<string, LspServerDef> = {}
  for (const entry of AUTO_LSP_CANDIDATES) {
    for (const candidate of entry.candidates) {
      const executable = findExecutable(candidate.command, options)
      if (executable === undefined) continue
      servers[entry.language] = {
        command: executable,
        ...(candidate.args === undefined ? {} : { args: [...candidate.args] }),
      }
      break
    }
  }
  return servers
}