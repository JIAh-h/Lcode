import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApprovalService } from '@lcode/approval'
import type { AgentRuntime } from '@lcode/lcode-desktop'
import { createAgentRuntime, createDesktopModelFeature } from '@lcode/lcode-desktop'
import type { SessionEvent } from '@lcode/session'
import { resolveLcodeHome } from '@lcode/util'

/**
 * 编码评测集（不属于 CI）。
 *
 * 每个 task 是一个独立的小仓库：fixture 复制到临时目录 → 真实模型跑一轮 → 再复制
 * hidden 测试 → 执行测试命令。hidden 测试在模型完成前不可见，避免“看着测试写答案”。
 *
 * 评测进程使用**隔离的临时 Lcode Home**：只复制 settings.json / .env / credentials，
 * 因此不会改动用户真实的权限预设、信任列表或会话记录。
 */

interface EvalTaskConfig {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly test: {
    readonly command: string
    readonly args: readonly string[]
    readonly timeoutMs?: number | undefined
  }
  readonly agentTimeoutMs?: number | undefined
}

interface EvalTask {
  readonly dir: string
  readonly config: EvalTaskConfig
}

interface TestRun {
  readonly code: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

interface EvalResult {
  readonly id: string
  readonly title: string
  readonly passed: boolean
  readonly reason: string
  readonly error?: string
  readonly durationMs: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly test: TestRun
  readonly workspaceKept?: string
}

interface EvalOptions {
  readonly tasksDir: string
  readonly taskIds: readonly string[]
  readonly home: string
  readonly model?: string | undefined
  readonly dryRun: boolean
  readonly keep: boolean
  readonly out?: string | undefined
  readonly verbose: boolean
}

export async function runEvalCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseEvalArgs(argv)
  if (parsed === 'help') {
    console.log(EVAL_USAGE)
    return 0
  }
  const options = parsed
  const all = loadTasks(options.tasksDir)
  const selected = options.taskIds.length === 0
    ? all
    : all.filter((task) => options.taskIds.includes(task.config.id))
  if (selected.length === 0) {
    console.error(`没有匹配的任务（任务目录：${options.tasksDir}）`)
    return 1
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const root = mkdtempSync(join(tmpdir(), 'lcode-eval-'))
  const evalHome = join(root, 'home')
  let runtime: AgentRuntime | undefined
  let disposeFeature: (() => void) | undefined
  const results: EvalResult[] = []
  try {
    if (!options.dryRun) {
      seedHome(options.home, evalHome)
      const feature = await createDesktopModelFeature({ home: evalHome })
      disposeFeature = () => feature.dispose()
      await seedCredentialRecords(feature.services, options.home)
      runtime = await createAgentRuntime({
        home: evalHome,
        services: feature.services,
        approval: createApprovalService({ channel: { ask: async () => 'allowed-once' } }),
        profile: 'cli-default',
      })
      await runtime.ctx.get('permissionPresets').set('工作区内修改')
      if (options.model !== undefined) {
        const slash = options.model.indexOf('/')
        if (slash <= 0 || slash === options.model.length - 1) {
          throw new Error('--model 需要 provider/model 形式')
        }
        await runtime.ctx.get('agentDefaultModel').set({
          provider: options.model.slice(0, slash),
          model: options.model.slice(slash + 1),
        })
      }
    }

    for (let index = 0; index < selected.length; index += 1) {
      const task = selected[index]
      if (task === undefined) continue
      console.log(`\n[${index + 1}/${selected.length}] ${task.config.id} · ${task.config.title}`)
      const workspace = join(root, `workspace-${task.config.id}`)
      cpSync(join(task.dir, 'fixture'), workspace, { recursive: true })
      const started = Date.now()
      let reason = options.dryRun ? 'solution' : 'error'
      let error: string | undefined
      let toolCalls = 0
      let inputTokens = 0
      let outputTokens = 0
      if (options.dryRun) {
        const solution = join(task.dir, 'solution')
        if (!existsSync(solution)) {
          error = '缺少 solution/，无法 dry-run'
          reason = 'dry-run-failed'
        } else {
          cpSync(solution, workspace, { recursive: true })
        }
      } else if (runtime !== undefined) {
        try {
          const stats = await runAgent(runtime, task, workspace, options)
          reason = stats.reason
          toolCalls = stats.toolCalls
          inputTokens = stats.inputTokens
          outputTokens = stats.outputTokens
          if (stats.error !== undefined) error = stats.error
        } catch (err) {
          reason = 'error'
          error = err instanceof Error ? err.message : String(err)
        }
      }

      const hidden = join(task.dir, 'hidden')
      if (existsSync(hidden)) cpSync(hidden, workspace, { recursive: true })
      const test = await runTest(task.config.test, workspace)
      const passed = test.code === 0 && !test.timedOut && error === undefined &&
        (options.dryRun || (reason !== 'error' && reason !== 'timeout'))
      const result: EvalResult = {
        id: task.config.id,
        title: task.config.title,
        passed,
        reason,
        ...(error === undefined ? {} : { error }),
        durationMs: Date.now() - started,
        toolCalls,
        inputTokens,
        outputTokens,
        test,
        ...(options.keep ? { workspaceKept: workspace } : {}),
      }
      results.push(result)
      printResult(result, options.verbose)
    }

    const passed = results.filter((result) => result.passed).length
    console.log(`\n结果：${passed}/${results.length} 通过${options.dryRun ? '（dry-run，未调用模型）' : ''}`)
    if (options.out !== undefined) {
      const out = resolve(options.out)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify({
        startedAt: runId,
        model: options.model ?? 'settings-default',
        dryRun: options.dryRun,
        results,
      }, null, 2))
      console.log(`已写入：${out}`)
    }
    return passed === results.length ? 0 : 1
  } finally {
    await runtime?.dispose()
    disposeFeature?.()
    if (options.keep) {
      console.log(`\n保留评测目录：${root}`)
    } else {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function runAgent(
  runtime: AgentRuntime,
  task: EvalTask,
  workspace: string,
  options: EvalOptions,
): Promise<{ reason: string; error?: string; toolCalls: number; inputTokens: number; outputTokens: number }> {
  runtime.ctx.get('workspaceTrust').setTrusted(workspace, true)
  const created = await runtime.sessions.create({
    cwd: workspace,
    title: `eval:${task.config.id}`,
  })
  const { agent_id } = await runtime.agents.resume({ session_id: created.session_id })
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let currentTurn: number | undefined
  let settle: ((reason: string) => void) | undefined
  const done = new Promise<string>((resolveDone) => {
    settle = resolveDone
  })
  const stop = runtime.watchSession(created.session_id, (event: SessionEvent) => {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (event.type === 'tool/call') {
      toolCalls += 1
      if (options.verbose) process.stderr.write(`  [tool] ${event.data.name}\n`)
    }
    if (event.type === 'assistant/chunk' && options.verbose && event.data.chunk.type === 'text-delta') {
      process.stderr.write(event.data.chunk.text)
    }
    if (event.type === 'assistant/message') {
      inputTokens += event.data.usage?.input ?? 0
      outputTokens += event.data.usage?.output ?? 0
    }
    if (event.type === 'turn/end' && currentTurn === event.data.turn) settle?.(event.data.reason)
  })
  try {
    await runtime.agents.followup({
      agent_id,
      content: [{ type: 'text', text: task.config.prompt }],
    })
    const timeoutMs = task.config.agentTimeoutMs ?? 300_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
    })
    const reason = await Promise.race([done, timeout])
    if (timer !== undefined) clearTimeout(timer)
    if (reason === 'timeout') {
      await runtime.agents.cancel({ agent_id, cause: 'user' })
      return { reason, toolCalls, inputTokens, outputTokens, error: `模型运行超过 ${Math.round(timeoutMs / 1000)}s` }
    }
    return { reason, toolCalls, inputTokens, outputTokens }
  } catch (err) {
    return {
      reason: 'error',
      toolCalls,
      inputTokens,
      outputTokens,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    stop()
  }
}

function runTest(
  test: EvalTaskConfig['test'],
  cwd: string,
): Promise<TestRun> {
  return new Promise((resolveRun) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (run: TestRun): void => {
      if (settled) return
      settled = true
      resolveRun(run)
    }
    const child = spawn(test.command, [...test.args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, test.timeoutMs ?? 60_000)
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (stdout.length < 20_000) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 20_000) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: null, timedOut, stdout: trim(stdout), stderr: trim(`${stderr}\n${error.message}`) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, timedOut, stdout: trim(stdout), stderr: trim(stderr) })
    })
  })
}

function printResult(result: EvalResult, verbose: boolean): void {
  const status = result.passed ? 'PASS' : 'FAIL'
  const seconds = (result.durationMs / 1000).toFixed(1)
  const tokens = result.inputTokens + result.outputTokens > 0
    ? ` · tokens ${result.inputTokens}+${result.outputTokens}`
    : ''
  console.log(`  ${status} ${seconds}s · tools ${result.toolCalls}${tokens} · turn ${result.reason}`)
  if (result.error !== undefined) console.log(`  error: ${result.error}`)
  if (!result.passed || verbose) {
    if (result.test.stdout !== '') console.log(`  stdout: ${result.test.stdout.replace(/\n/g, '\n          ')}`)
    if (result.test.stderr !== '') console.log(`  stderr: ${result.test.stderr.replace(/\n/g, '\n          ')}`)
  }
  if (result.workspaceKept !== undefined) console.log(`  workspace: ${result.workspaceKept}`)
}

function loadTasks(dir: string): EvalTask[] {
  const root = resolve(dir)
  if (!existsSync(root)) throw new Error(`任务目录不存在：${root}`)
  const tasks: EvalTask[] = []
  for (const name of readdirSync(root).sort()) {
    const taskDir = join(root, name)
    const manifestPath = join(taskDir, 'task.json')
    if (!existsSync(manifestPath)) continue
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<EvalTaskConfig>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.title !== 'string' ||
      typeof parsed.prompt !== 'string' ||
      typeof parsed.test !== 'object' ||
      parsed.test === null ||
      typeof parsed.test.command !== 'string' ||
      !Array.isArray(parsed.test.args)
    ) {
      throw new Error(`task.json 字段不完整：${manifestPath}`)
    }
    tasks.push({
      dir: taskDir,
      config: {
        id: parsed.id,
        title: parsed.title,
        prompt: parsed.prompt,
        test: {
          command: parsed.test.command,
          args: parsed.test.args.filter((arg): arg is string => typeof arg === 'string'),
          ...(typeof parsed.test.timeoutMs === 'number' ? { timeoutMs: parsed.test.timeoutMs } : {}),
        },
        ...(typeof parsed.agentTimeoutMs === 'number' ? { agentTimeoutMs: parsed.agentTimeoutMs } : {}),
      },
    })
  }
  if (tasks.length === 0) throw new Error(`任务目录里没有 task.json：${root}`)
  return tasks
}

/** 复制模型配置与凭据，写一份安全的权限预设；真实 Lcode Home 不被修改。 */
function seedHome(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const name of ['settings.json', '.env']) {
    const file = join(source, name)
    if (existsSync(file)) cpSync(file, join(target, name))
  }
  const credentials = join(source, 'credentials')
  if (existsSync(credentials)) cpSync(credentials, join(target, 'credentials'), { recursive: true })
  writeFileSync(join(target, 'permission-preset.json'), JSON.stringify({
    version: 1,
    preset: '工作区内修改',
    source: 'user',
    audit: [],
  }, null, 2))
}

/**
 * 凭据值文件复制过来了，但 `credentials_refs` 记录在真实 home 的 index.db 里。
 * 在评测 home 重新登记一遍（值只在内存里中转，不打印）。
 */
async function seedCredentialRecords(
  services: Awaited<ReturnType<typeof createDesktopModelFeature>>['services'],
  sourceHome: string,
): Promise<void> {
  const dir = join(sourceHome, 'credentials')
  if (!existsSync(dir)) return
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { ref?: unknown; value?: unknown }
      if (typeof parsed.ref !== 'string' || typeof parsed.value !== 'string' || parsed.ref === '' || parsed.value === '') continue
      await services.credentials.write(parsed.ref, parsed.value)
    } catch {
      // 单个损坏的凭据文件不影响其它配置
    }
  }
}

function parseEvalArgs(argv: readonly string[]): EvalOptions | 'help' {
  let tasksDir = 'evals/coding/tasks'
  const taskIds: string[] = []
  let home = resolveLcodeHome()
  let model: string | undefined
  let dryRun = false
  let keep = false
  let out: string | undefined
  let verbose = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--help':
      case '-h':
        return 'help'
      case '--tasks':
        tasksDir = argv[++index] ?? tasksDir
        break
      case '--task':
        taskIds.push(argv[++index] ?? '')
        break
      case '--home':
        home = resolve(argv[++index] ?? home)
        break
      case '--model':
        model = argv[++index]
        break
      case '--out':
        out = argv[++index]
        break
      case '--dry-run':
        dryRun = true
        break
      case '--keep':
        keep = true
        break
      case '--verbose':
        verbose = true
        break
      default:
        if (arg !== undefined && arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    }
  }
  if (taskIds.some((id) => id === '')) throw new Error('--task 需要任务 id')
  let resolvedTasks = resolve(tasksDir)
  if (!existsSync(resolvedTasks)) {
    // 从 apps/cli 运行脚本时，默认任务目录在仓库根
    resolvedTasks = resolve(process.cwd(), '../../evals/coding/tasks')
  }
  return {
    tasksDir: resolvedTasks,
    taskIds,
    home,
    ...(model === undefined ? {} : { model }),
    dryRun,
    keep,
    ...(out === undefined ? {} : { out }),
    verbose,
  }
}

function trim(text: string): string {
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…（截断）` : text.trim()
}

const EVAL_USAGE = `编码评测集（真实模型；不属于 CI）

  lcode eval [--tasks <dir>] [--task <id> ...] [--model <provider/model>]
             [--home <dir>] [--out <file>] [--verbose] [--keep] [--dry-run]

  --dry-run   不调用模型，把 solution/ 覆盖到 fixture 后跑 hidden 测试（验证题目本身）
  --keep      保留临时评测目录（含工作区与会话）

任务格式见 evals/coding/README.md。`

// 直接用 tsx 跑本文件时执行；被 CLI 入口 import 时只导出 runEvalCommand
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runEvalCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
