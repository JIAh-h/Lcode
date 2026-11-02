import type { LspQueryInput, LspService } from '@lcode/lsp'
import { createLspStdioClient, type LspStdioClient } from '@lcode/lsp-stdio'
import type { SubprocessService } from '@lcode/subprocess'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 一个语言服务器进程的启动配置（不允许 shell 字符串，参数逐项给出）。 */
export interface LspServerDef {
  readonly command: string
  readonly args?: readonly string[] | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
}

export interface LocalLspOptions {
  /** language → server；未配置的语言查询会返回可操作的错误 */
  readonly servers: Readonly<Record<string, LspServerDef>>
  readonly subprocess: SubprocessService
  /** 找不到会话工作区时的兜底根目录 */
  readonly defaultWorkspace: string
  /** 文件读取由宿主注入（LSP 能力不得直接使用 node:fs）；默认拒绝读取。 */
  readonly readFile?: ((absolutePath: string) => Promise<string> | string) | undefined
  readonly initializeTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly diagnosticsTimeoutMs?: number
}

export interface LspLocationItem {
  readonly path: string
  readonly line: number
  readonly column: number
}

export interface LspDiagnosticItem {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
  readonly severity: 'error' | 'warning' | 'info' | 'hint'
  readonly message: string
  readonly source?: string | undefined
  readonly code?: string | undefined
}

export interface LocalLspService extends LspService {
  readonly configuredLanguages: readonly string[]
  dispose(): Promise<void>
}

interface OpenedFile {
  readonly version: number
  readonly text: string
}

interface Session {
  readonly root: string
  readonly language: string
  readonly client: LspStdioClient
  readonly opened: Map<string, OpenedFile>
  readonly diagnostics: Map<string, readonly LspDiagnosticItem[]>
}

/** 常见别名收敛到配置键 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  go: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  sh: 'bash',
  shell: 'bash',
}

/** 缺少语言服务器时给模型/用户一条能直接执行的安装命令。 */
const INSTALL_HINTS: Readonly<Record<string, string>> = {
  typescript: '重新安装 Lcode（typescript-language-server 随包分发）',
  javascript: '重新安装 Lcode（typescript-language-server 随包分发）',
  rust: 'rustup component add rust-analyzer',
  go: 'go install golang.org/x/tools/gopls@latest',
  python: 'pip install python-lsp-server（提供 pylsp）',
  c: '安装 clangd（LLVM）',
  cpp: '安装 clangd（LLVM）',
  lua: '安装 lua-language-server',
  bash: 'npm install -g bash-language-server',
}

function normalizeLanguage(language: string): string {
  const value = language.trim().toLowerCase()
  return LANGUAGE_ALIASES[value] ?? value
}

export function createLocalLsp(options: LocalLspOptions): LocalLspService {
  const sessions = new Map<string, Promise<Session>>()
  const initializeTimeoutMs = options.initializeTimeoutMs ?? 20_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  const diagnosticsTimeoutMs = options.diagnosticsTimeoutMs ?? 3_000

  const serverFor = (language: string): LspServerDef => {
    const def = options.servers[language]
    if (def === undefined) {
      const discovered = Object.keys(options.servers).join('、')
      const hint = INSTALL_HINTS[language] ?? `在 ~/.lcode/lsp.json 里配置 ${language} 的启动命令`
      throw new Error(
        `没有为语言「${language}」找到语言服务器。Lcode 会自动发现 PATH 里的常见服务器；` +
        `当前已发现：${discovered === '' ? '无' : discovered}。安装建议：${hint}。`,
      )
    }
    return def
  }

  const startSession = async (language: string, root: string): Promise<Session> => {
    const def = serverFor(language)
    const client = await createLspStdioClient({
      argv: [def.command, ...(def.args ?? [])],
      cwd: root,
      ...(def.env === undefined ? {} : { env: def.env }),
      subprocess: options.subprocess,
    })
    const uri = pathToFileURL(root).href
    try {
      await client.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: uri,
          workspaceFolders: [{ uri, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root }],
          capabilities: {
            workspace: { configuration: true },
            textDocument: {
              synchronization: {},
              definition: { linkSupport: true },
              references: {},
              publishDiagnostics: { relatedInformation: true },
            },
          },
        },
        AbortSignal.timeout(initializeTimeoutMs),
      )
      client.notify('initialized', {})
    } catch (error) {
      await client.close().catch(() => undefined)
      throw new Error(`语言服务器（${language}）初始化失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const session: Session = { root, language, client, opened: new Map(), diagnostics: new Map() }
    // 常驻订阅：把诊断缓存下来，重复查询无需再等服务器推送
    client.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
      const published = record['uri']
      if (typeof published !== 'string') return
      try {
        const absolute = fileURLToPath(published)
        const rel = relative(root, absolute)
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
        session.diagnostics.set(canonicalUri(published), toDiagnostics(params, root, absolute))
      } catch {
        // 非文件 URI 忽略
      }
    })
    return session
  }

  const sessionFor = (language: string, root: string): Promise<Session> => {
    const key = `${language}\u0000${root}`
    const existing = sessions.get(key)
    if (existing !== undefined) return existing
    const created = startSession(language, root).catch((error: unknown) => {
      // 启动失败不缓存，下次查询可以重试（例如用户刚装好语言服务器）
      sessions.delete(key)
      throw error
    })
    sessions.set(key, created)
    return created
  }

  const languageIdOf = (language: string, filePath: string): string => {
    if (language !== 'typescript') return language
    return /\.(tsx|jsx)$/.test(filePath) ? (filePath.endsWith('.tsx') ? 'typescriptreact' : 'javascriptreact') : 'typescript'
  }

  const openFile = async (session: Session, absolutePath: string): Promise<{ uri: string; file: OpenedFile }> => {
    const uri = pathToFileURL(absolutePath).href
    if (options.readFile === undefined) throw new Error('LSP 未配置文件读取 Provider')
    const text = await options.readFile(absolutePath)
    const existing = session.opened.get(uri)
    if (existing === undefined) {
      session.client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdOf(session.language, absolutePath), version: 1, text },
      })
      const file = { version: 1, text }
      session.opened.set(uri, file)
      return { uri, file }
    }
    if (existing.text === text) return { uri, file: existing }
    const version = existing.version + 1
    session.client.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
    const file = { version, text }
    session.opened.set(uri, file)
    return { uri, file }
  }

  const toLocationItems = (result: unknown, root: string): LspLocationItem[] => {
    if (!Array.isArray(result)) return []
    const items: LspLocationItem[] = []
    for (const value of result) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      const target = typeof record['targetUri'] === 'string'
        ? (record['targetSelectionRange'] ?? record['targetRange'])
        : record['range']
      const uri = typeof record['targetUri'] === 'string' ? record['targetUri'] : record['uri']
      const range = isRange(target) ? target : undefined
      if (typeof uri !== 'string' || range === undefined) continue
      let filePath: string
      try {
        filePath = fileURLToPath(uri)
      } catch {
        continue
      }
      const rel = relative(root, filePath)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
      items.push({ path: rel.replace(/\\/g, '/'), line: range.start.line + 1, column: range.start.character + 1 })
    }
    return items
  }

  const toDiagnostics = (params: unknown, root: string, absolutePath: string): LspDiagnosticItem[] => {
    const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    const diagnostics = Array.isArray(record['diagnostics']) ? record['diagnostics'] : []
    const rel = relative(root, absolutePath).replace(/\\/g, '/')
    const severityOf = (value: unknown): LspDiagnosticItem['severity'] =>
      value === 1 ? 'error' : value === 2 ? 'warning' : value === 3 ? 'info' : 'hint'
    const items: LspDiagnosticItem[] = []
    for (const value of diagnostics) {
      const item = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
      const range = isRange(item['range']) ? item['range'] : undefined
      if (range === undefined || typeof item['message'] !== 'string') continue
      items.push({
        path: rel,
        line: range.start.line + 1,
        column: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1,
        severity: severityOf(item['severity']),
        message: item['message'],
        ...(typeof item['source'] === 'string' ? { source: item['source'] } : {}),
        ...(typeof item['code'] === 'string' ? { code: item['code'] } : {}),
      })
    }
    return items
  }

  const waitDiagnostics = (session: Session, uri: string, absolutePath: string): Promise<readonly LspDiagnosticItem[]> => {
    const key = canonicalUri(uri)
    const cached = session.diagnostics.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        off()
        resolvePromise([])
      }, diagnosticsTimeoutMs)
      const off = session.client.onNotification((method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return
        const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
        if (typeof record['uri'] !== 'string' || canonicalUri(record['uri']) !== key) return
        clearTimeout(timer)
        off()
        resolvePromise(toDiagnostics(params, session.root, absolutePath))
      })
    })
  }

  const query = async (input: LspQueryInput): Promise<readonly unknown[]> => {
    const language = normalizeLanguage(input.language)
    const root = resolve(input.workspaceRoot === '' ? options.defaultWorkspace : input.workspaceRoot)
    const absolutePath = isAbsolute(input.filePath) ? resolve(input.filePath) : resolve(root, input.filePath)
    const rel = relative(root, absolutePath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('文件路径必须位于当前工作区内')
    const session = await sessionFor(language, root)

    if (input.kind === 'diagnostics') {
      const uri = pathToFileURL(absolutePath).href
      await openFile(session, absolutePath)
      return await waitDiagnostics(session, uri, absolutePath)
    }

    const { uri } = await openFile(session, absolutePath)

    const line = input.line === undefined ? 1 : input.line
    const character = input.character === undefined ? 1 : input.character
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
      throw new Error('line / character 必须是 ≥1 的整数（1-based）')
    }
    const position = { line: line - 1, character: character - 1 }
    if (input.kind === 'definition') {
      const result = await session.client.request(
        'textDocument/definition',
        { textDocument: { uri }, position },
        AbortSignal.timeout(requestTimeoutMs),
      )
      return toLocationItems(result, root)
    }
    const result = await session.client.request(
      'textDocument/references',
      { textDocument: { uri }, position, context: { includeDeclaration: true } },
      AbortSignal.timeout(requestTimeoutMs),
    )
    return toLocationItems(result, root)
  }

  return {
    configuredLanguages: Object.keys(options.servers),
    query,
    async dispose() {
      const pending = [...sessions.values()]
      sessions.clear()
      for (const entry of pending) {
        try {
          const session = await entry
          await session.client.close()
        } catch {
          // 启动失败的会话没有进程可关
        }
      }
    },
  }
}

/** 服务端回显的 URI 可能把盘符写成小写并做百分号编码，统一成真实路径键 */
function canonicalUri(uri: string): string {
  try {
    const filePath = fileURLToPath(uri)
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath
  } catch {
    return uri
  }
}

function isRange(value: unknown): value is { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const start = record['start']
  const end = record['end']
  const valid = (point: unknown): point is { line: number; character: number } => {
    if (typeof point !== 'object' || point === null) return false
    const p = point as Record<string, unknown>
    return typeof p['line'] === 'number' && typeof p['character'] === 'number'
  }
  return valid(start) && valid(end)
}
