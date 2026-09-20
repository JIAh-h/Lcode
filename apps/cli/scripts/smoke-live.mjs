import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * CLI MVP 真实冒烟：使用用户已配置的模型，不启动假模型。
 *
 * ① 工作区内任务确认无 GUI 也能完成一轮；
 * ② 无 TTY 时工作区外写入必须 fail-closed，且不能产生副作用。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const home = process.env.LCODE_HOME ?? join(homedir(), '.lcode')
const workspace = mkdtempSync(join(tmpdir(), 'lcode-cli-live-workspace-'))
const outside = join(tmpdir(), `lcode-cli-live-out-${Date.now()}.txt`)
writeFileSync(join(workspace, 'fixture.txt'), 'CLI_FIXTURE_OK\n', 'utf8')

if (!existsSync(join(root, 'apps', 'cli', 'src', 'index.ts'))) throw new Error(`找不到 CLI 入口：${root}`)

try {
  const inside = await runCli([
    'run',
    '必须按顺序调用工具：用 read 读取 fixture.txt，然后用 shell 执行 node -e "console.log(\'CLI_LIVE_OK\')"，最后简短总结。不要只解释。',
    '--cwd',
    workspace,
  ])
  if (inside.code !== 0 || !inside.stdout.includes('CLI_LIVE_OK') || !inside.stderr.includes('[read]') || !inside.stderr.includes('[shell]')) {
    throw new Error(`CLI 工作区内任务失败：${JSON.stringify(inside)}`)
  }
  console.log(`① CLI 工作区内任务通过：${workspace}`)

  const denied = await runCli([
    'run',
    `必须调用 write，把 CLI_APPROVAL_OK 写入 ${outside}。这是工作区外路径；即使需要审批也要发起工具调用，不要只解释。`,
    '--cwd',
    workspace,
  ])
  const deniedOutput = `${denied.stdout}\n${denied.stderr}`
  if (denied.code !== 0 || !deniedOutput.includes('EP-APPROVAL_UNAVAILABLE') || existsSync(outside)) {
    throw new Error(`CLI 无 TTY 审批 fail-closed 失败：${JSON.stringify(denied)}`)
  }
  console.log(`② CLI 无 TTY 审批保守拒绝通过：${outside}`)
  console.log('✅ CLI MVP 真实任务闭环通过')
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { force: true })
}

function runCli(args) {
  const tsx = resolve(root, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [tsx, resolve(root, 'apps', 'cli', 'src', 'index.ts'), ...args], {
      cwd: root,
      env: { ...process.env, LCODE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => resolveResult({ code: code ?? 1, signal, stdout, stderr }))
  })
}
