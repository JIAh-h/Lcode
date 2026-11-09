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

/**
 * 原生执行 API 白名单（P5-00）。
 *
 * - `roots`：整个目录允许——那是可替换 Provider 的实现本体，用原生 API 是它的职责。
 * - `bindings`：**只允许列出的绑定**，其余绑定（读写、派生进程）仍然违规。
 *
 * 为什么 `packages/fs/fs/src/` 需要 `realpathSync`：工作区边界判定与写入许可以及
 * `fs-local` / `fs-sandbox` 自身都必须用**同一条**真实路径，否则策略层与执行层对
 * "这个路径算不算在工作区内"会给出两个答案。它是纯元数据读取（不读内容、不写、不派生
 * 进程），也不构成模型可调用的 I/O 入口；把它下沉到某个实现包会让策略层反过来依赖具体
 * 实现（违反 20 §3）或让同一份规范化逻辑出现第二份（P5-00 要防的正是这个）。
 * 具体取舍见 docs/12 §3.3 的 2026-11-02 记录。
 */
const rawExecutionApis = new Map([
  [
    'node:fs',
    {
      roots: ['packages/fs/fs-local/src/'],
      bindings: { 'packages/fs/fs/src/': ['realpathSync'] },
    },
  ],
  ['node:fs/promises', { roots: ['packages/fs/fs-local/src/'], bindings: {} }],
  ['node:child_process', { roots: ['packages/subprocess/subprocess-local/src/'], bindings: {} }],
  ['node-pty', { roots: ['packages/subprocess/subprocess-local/src/'], bindings: {} }],
])

/**
 * 判断一次 import 是否被白名单放行；返回 null 表示违规原因。
 *
 * 只放行**具名导入**且全部落在 `bindings` 列表内。默认导入、命名空间导入
 * （`import * as fs`）一律视为绕过白名单——它们可以拿到模块上的任意成员。
 */
function allowedByBinding(fileName, node) {
  const clause = node.importClause
  if (clause === undefined || clause.name !== undefined) return null // 默认导入：不可控
  const named = clause.namedBindings
  if (named === undefined || !ts.isNamedImports(named)) return null // 命名空间导入：不可控
  const imported = named.elements.map((element) => element.propertyName?.text ?? element.name.text)
  if (imported.length === 0) return null
  return imported
}

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
 *
 * 例外按**绑定**而不是按目录放行：接口层只拿到真实路径解析（纯元数据读取），
 * 读内容、写文件、派生进程仍然只能在 Provider 内出现。
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
          const policy = rawExecutionApis.get(node.moduleSpecifier.text)
          if (policy !== undefined && !policy.roots.some((allowedRoot) => fileName.startsWith(allowedRoot))) {
            const enforced = boundException(policy, fileName, node)
            if (enforced === null) {
              violations.push({
                location: location(sourceFile, node.moduleSpecifier),
                message: `消费者直接导入原生执行 API「${node.moduleSpecifier.text}」`,
              })
            } else if (enforced !== '') {
              violations.push({
                location: location(sourceFile, node.moduleSpecifier),
                message: `接口层只允许导入 ${enforced}，不得导入「${node.moduleSpecifier.text}」的其它成员`,
              })
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
  }
  return violations
}

/**
 * 绑定级白名单判定：'' = 放行，字符串 = 该文件允许的绑定清单（用于报错），null = 不在白名单。
 */
function boundException(policy, fileName, node) {
  let allowed = null
  for (const [allowedRoot, bindings] of Object.entries(policy.bindings)) {
    if (fileName.startsWith(allowedRoot)) allowed = bindings
  }
  if (allowed === null) return null
  const imported = allowedByBinding(fileName, node)
  if (imported === null) return null
  return imported.every((name) => allowed.includes(name)) ? '' : `{ ${allowed.join(', ')} }`
}

/**
 * P11-05：跨会话编排的两条硬边界（docs/26 §7.2 / §7.5.2）。
 *
 * ① **审批归属**：worker 的授权不得从 Router 的 `approvalPolicy` / `preset` 继承。
 *    `history.why` 要能回答"这个写操作是谁批的"；一旦继承，归因链就指向一个
 *    根本没经历过那次审批的会话。
 * ② **派发深度**：worker 不允许再派发 worker（深度硬编码 1）。
 *
 * 这两条必须是静态门禁而不是 code review——它们是审计链与成本结构的根。
 */
export function scanOrchestrationBoundaries(root) {
  const violations = []
  const orchestrationSrc = join(root, 'packages/core/orchestration-local/src')
  if (statSync(orchestrationSrc, { throwIfNoEntry: false })?.isDirectory()) {
    for (const file of walk(orchestrationSrc)) {
      const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      function visit(node) {
        /*
         * 检查 `create({ ... })` 里是否把 Router 的审批档带进了 worker。
         * 允许读 workspace（归属需要的路径），不允许读 approvalPolicy / preset。
         */
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'create') {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue
            for (const property of arg.properties) {
              if (!ts.isPropertyAssignment(property)) continue
              const key = property.name.getText(sourceFile)
              if (key === 'approvalPolicy' || key === 'preset' || key === 'approval') {
                violations.push({
                  location: location(sourceFile, property),
                  message: `worker 会话不得继承 Router 的 ${key}（docs/26 §7.2：审批必须落在 worker 自己）`,
                })
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
  }

  /*
   * ② 派发深度：编排实现里不得出现"递归派发"的入口。
   * 具体检查：orchestration-local 不得把 dispatch 能力再传给 worker 的 scope。
   */
  const dispatchTool = join(root, 'packages/bundle/lcode-desktop/src/tool-dispatch-worker.ts')
  if (statSync(dispatchTool, { throwIfNoEntry: false })?.isFile()) {
    const source = readFileSync(dispatchTool, 'utf8')
    if (!source.includes('roleOf') && !source.includes('worker 不能派发')) {
      violations.push({
        location: dispatchTool.slice(root.length + 1),
        message: '派发工具缺少"worker 不能派发 worker"的判定（docs/26 §7.5.2）',
      })
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
  const violations = [...scanI6(root), ...scanExecutionEntrypoints(root), ...scanOrchestrationBoundaries(root)]
  for (const violation of violations) {
    console.error(`✗ 门禁违规：${violation.location} ${violation.message}`)
  }
  if (violations.length > 0) process.exit(1)
  console.log('✓ I6 AST 与 P5-00 执行入口检查通过；I1-I5/I7 由 Vitest 事件/回放/凭据测试守护')
}
