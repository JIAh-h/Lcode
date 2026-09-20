// 七条不变量与执行入口门禁（文档 15 §2 / 门禁 G6）。
// I1-I5/I7 由 Vitest 中的事件、回放、凭据和日志测试守护；I6 使用 TypeScript AST
// 扫描 agent-loop，避免把注释或字符串里的文字误判成核心循环业务分支。
// P5-00 额外扫描能力消费者，阻止裸 node:fs / child_process / node-pty 重新绕过 Provider。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const forbiddenIdentifiers = new Set([
  'needsApproval',
  'approval',
  'tokenLimit',
  'contextWindow',
  'rateLimit',
  'maxSteps',
  'needsCompaction',
  'isSandboxed',
  'outsideWorkspace',
  'requiresPermission',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // pnpm 会把工作区依赖链接到每个包的 node_modules；门禁只检查本仓库的源码，
    // 不能沿链接把同一份依赖重复扫成“消费者绕过”。
    if (name === 'node_modules') continue
    const file = join(dir, name)
    if (statSync(file).isDirectory()) walk(file, out)
    else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) out.push(file)
  }
  return out
}

function location(sourceFile, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  return `${sourceFile.fileName}:${line}`
}

/** 返回 I6 违规，供 CLI 门禁和故意违规探针共用。 */
export function scanI6(root) {
  const agentLoop = join(root, 'packages/core/agent-loop/src')
  const violations = []
  for (const file of walk(agentLoop)) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    function visit(node) {
      if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
        violations.push({
          location: location(sourceFile, node),
          message: `出现能力分支标识符「${node.text}」`,
        })
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === 'tokens'
      ) {
        violations.push({
          location: location(sourceFile, node),
          message: '对 tokens 做上限判断',
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return violations
}

const rawExecutionApis = new Map([
  ['node:fs', ['packages/fs/fs-local/src/']],
  ['node:fs/promises', ['packages/fs/fs-local/src/']],
  ['node:child_process', ['packages/subprocess/subprocess-local/src/']],
  ['node-pty', ['packages/subprocess/subprocess-local/src/']],
])

const executionCapabilityRoots = [
  'packages/fs',
  'packages/shell',
  'packages/terminal',
  'packages/lsp',
  'packages/subprocess',
]

/**
 * P5-00：原生 I/O 只能留在可替换 Provider 内。
 *
 * 这不是禁止 Provider 用 Node API，而是禁止工具、shell、PTY 等消费者绕过 Provider
 * 自己触发副作用。扫描范围刻意只含模型可调用的文件、Shell、终端、LSP 和子进程能力族；
 * 设置持久化、会话落盘等宿主基础设施不属于模型执行入口，不应被这条规则误伤。
 */
export function scanExecutionEntrypoints(root) {
  const violations = []
  for (const capabilityRoot of executionCapabilityRoots) {
    const directory = join(root, capabilityRoot)
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const file of walk(directory)) {
      const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const fileName = file.slice(root.length + 1).replace(/\\/g, '/')
      function visit(node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const allowedRoots = rawExecutionApis.get(node.moduleSpecifier.text)
          if (allowedRoots !== undefined && !allowedRoots.some((allowedRoot) => fileName.startsWith(allowedRoot))) {
            violations.push({
              location: location(sourceFile, node.moduleSpecifier),
              message: `消费者直接导入原生执行 API「${node.moduleSpecifier.text}」`,
            })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
  }
  return violations
}

function rootFromArgs() {
  const index = process.argv.indexOf('--root')
  return index >= 0 && process.argv[index + 1] !== undefined ? resolve(process.argv[index + 1]) : process.cwd()
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = rootFromArgs()
  const violations = [...scanI6(root), ...scanExecutionEntrypoints(root)]
  for (const violation of violations) {
    console.error(`✗ 门禁违规：${violation.location} ${violation.message}`)
  }
  if (violations.length > 0) process.exit(1)
  console.log('✓ I6 AST 与 P5-00 执行入口检查通过；I1-I5/I7 由 Vitest 事件/回放/凭据测试守护')
}
