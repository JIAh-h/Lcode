import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {} from '@lcode/context'
import { memoryRoot, normalizePath } from '@lcode/util'

/**
 * 本地记忆存储（docs/28）。
 *
 * ## 两层记忆，两种归属
 *
 * | 层 | 文件 | 谁写 | 跟着谁走 |
 * |---|---|---|---|
 * | **用户记忆** | `<home>/memory/USER.md` | 用户（可编辑） | 人：换项目也在 |
 * | **项目记忆** | `<workspace>/AGENTS.md` 等 | 人 / 模型候选 + 人确认 | 仓库：团队共享 |
 *
 * ## 与提示缓存的关系（docs/09 §3.2.6）
 *
 * 记忆是**稳定内容**：只有在用户改动它时才变。因此它进系统提示词（稳定前缀），
 * 而不是每轮追加——后者会让前缀每步都断在记忆处。
 *
 * 代价是：**写入记忆 = 一次缓存失效**。所以写入必须批量（会话结束一次），
 * 不能每轮都写。
 */

/** 用户记忆文件名（`<home>/memory/USER.md`） */
export const USER_MEMORY_FILE = 'USER.md'

/**
 * 记忆注入的硬上限。
 *
 * 与 Claude Code 的 `MEMORY.md` 同量级（200 行 / 25KB）：记忆进稳定前缀，
 * 体积直接决定每一步的固定成本。超了就截断并如实告知，而不是无声地撑大前缀。
 */
export const MEMORY_MAX_CHARS = 25_000
export const MEMORY_MAX_LINES = 200

export interface MemoryFileInfo {
  /** 展示用文件名 */
  readonly name: string
  /** 绝对路径（用户记忆）或相对工作区路径（项目记忆） */
  readonly path: string
  readonly chars: number
  readonly lines: number
  readonly updatedAt: number
  /** 是否因超限被截断 */
  readonly truncated: boolean
}

export interface MemorySnapshot {
  readonly user: MemoryFileInfo | null
  readonly project: readonly MemoryFileInfo[]
  /** 真正会被注入的合并文本（已按上限裁剪） */
  readonly injected: string
  /** 注入文本的字符数（用于界面显示成本） */
  readonly injectedChars: number
}

export interface MemoryStore {
  /** 读取当前生效的记忆（不写盘） */
  read(input: { readonly home: string; readonly workspaceRoot?: string | undefined }): MemorySnapshot
  /** 写用户记忆（整文件覆盖）。返回写入后的信息。 */
  writeUser(input: { readonly home: string; readonly text: string }): MemoryFileInfo
  /** 读用户记忆原文（编辑用；不存在返回空串） */
  readUser(input: { readonly home: string }): string
}

/** 项目记忆的候选文件名，按此顺序拼进上下文 */
const PROJECT_MEMORY_FILES = ['AGENTS.md', 'CLAUDE.md', '.lcode/instructions.md'] as const

declare module '@lcode/context' {
  interface Services { memory: MemoryStore }
}

/**
 * 按行/字符双上限裁剪。
 *
 * 两个上限都要：只有字符上限时，一条超长的单行也能塞进来（行数没超但语义很差）；
 * 只有行数上限时，短行能堆出巨大的体积。
 */
function clamp(text: string): { readonly text: string; readonly truncated: boolean } {
  const lines = text.split('\n')
  let truncated = false
  let kept = lines
  if (kept.length > MEMORY_MAX_LINES) {
    kept = kept.slice(0, MEMORY_MAX_LINES)
    truncated = true
  }
  let out = kept.join('\n')
  if (out.length > MEMORY_MAX_CHARS) {
    out = out.slice(0, MEMORY_MAX_CHARS)
    truncated = true
  }
  return { text: truncated ? `${out}\n\n… (memory truncated at ${MEMORY_MAX_LINES} lines / ${MEMORY_MAX_CHARS} chars)` : out, truncated }
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

function info(name: string, path: string, text: string): MemoryFileInfo {
  return {
    name,
    path,
    chars: text.length,
    lines: countLines(text),
    updatedAt: Date.now(),
    truncated: false,
  }
}

function readIfExists(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readProjectFile(workspaceRoot: string, rel: string): { readonly info: MemoryFileInfo; readonly text: string } | undefined {
  const text = readIfExists(join(workspaceRoot, rel))
  if (text === undefined || text.trim() === '') return undefined
  let updatedAt = Date.now()
  try {
    updatedAt = statSync(join(workspaceRoot, rel)).mtimeMs
  } catch {
    // 读不到 mtime 就用当前时间：展示层只是参考，不影响注入内容
  }
  return { info: { ...info(rel.replaceAll('/', '\\'), rel, text), updatedAt }, text }
}

export function createLocalMemoryStore(): MemoryStore {
  return {
    read({ home, workspaceRoot }) {
      const sections: string[] = []
      const project: MemoryFileInfo[] = []

      // 项目记忆：工作区内的指令文件（团队共享，随仓库提交）
      if (workspaceRoot !== undefined && workspaceRoot !== '') {
        const root = normalizePath(workspaceRoot)
        for (const rel of PROJECT_MEMORY_FILES) {
          const found = readProjectFile(root, rel)
          if (found === undefined) continue
          project.push(found.info)
          sections.push(`### Project memory: ${rel}\n${found.text}`)
        }
      }

      // 用户记忆：跟着人走
      let user: MemoryFileInfo | null = null
      const userPath = join(memoryRoot(home), USER_MEMORY_FILE)
      const userText = readIfExists(userPath)
      if (userText !== undefined && userText.trim() !== '') {
        let updatedAt = Date.now()
        try {
          updatedAt = statSync(userPath).mtimeMs
        } catch {
          // 同上：仅展示用
        }
        user = { ...info(USER_MEMORY_FILE, userPath, userText), updatedAt }
        // 用户记忆排在项目记忆之前：个人偏好优先于项目约定
        sections.unshift(`### User memory\n${userText}`)
      }

      const merged = sections.join('\n\n')
      const clamped = clamp(merged)
      return {
        user,
        project,
        injected: clamped.text,
        injectedChars: clamped.text.length,
      }
    },

    writeUser({ home, text }) {
      const root = memoryRoot(home)
      mkdirSync(root, { recursive: true })
      const path = join(root, USER_MEMORY_FILE)
      // 末尾统一补一个换行：避免下次追加时黏在最后一行
      writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
      return info(USER_MEMORY_FILE, path, text)
    },

    readUser({ home }) {
      return readIfExists(join(memoryRoot(home), USER_MEMORY_FILE)) ?? ''
    },
  }
}
