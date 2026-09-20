// 性能基准（门禁 G16 / 15 §7：启动 / 会话回放 / 内存 / 包体）。
// portable 首启使用真实 Electron 渲染器/桥/落盘验收；真实模型首 token 由
// smoke-live-model 的受控付费探针测量，离线 bench 不将它伪造成零成本指标。
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const resultPath = join(root, 'bench', 'result.json')
const baselinePath = join(root, 'bench', 'baseline.json')
const portable = join(root, 'out', 'lcode-win32-x64', 'Lcode.exe')
const archive = join(root, 'out', 'lcode-win32-x64.zip')
const execFileAsync = promisify(execFile)

mkdirSync(dirname(resultPath), { recursive: true })
const session = await runSessionBenchmark()
const portableAcceptance = existsSync(portable) ? await runPortableAcceptance() : null
const coldStart = portableAcceptance?.firstStartMs ?? null
const archiveBytes = existsSync(archive) ? statSync(archive).size : null
const result = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  coldStartMs: coldStart,
  portableRestartMs: portableAcceptance?.restartStartMs ?? null,
  rendererIdleFps: portableAcceptance?.rendererFrames?.fps ?? null,
  rendererFrameP95Ms: portableAcceptance?.rendererFrames?.p95Ms ?? null,
  replay: session.results,
  replayRssMb: session.rssMb,
  archiveBytes,
  archiveLimitBytes: 150 * 1024 * 1024,
  skipped: {
    firstTokenMs: '由 smoke-live-model.mjs 的真实默认模型探针测量；离线 bench 不发付费请求',
    scrollFps: '已测空闲 renderer 帧率；长会话滚动仍需要专用 probe',
    timelineSeekMs: '需要 10 万事件 replay 定位 probe',
    crossPlatform: '当前运行机为 Windows，等待 macOS/Linux 基准机',
  },
}
writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`bench: 已更新基线 ${baselinePath}`)
}

console.log(JSON.stringify(result, null, 2))
const failures = []
if (archiveBytes !== null && archiveBytes > result.archiveLimitBytes) failures.push(`archive=${archiveBytes} > ${result.archiveLimitBytes}`)
const replay10k = session.results.find((item) => item.events === 10000)
if (replay10k !== undefined && replay10k.deriveMs > 960) failures.push(`replay10k=${replay10k.deriveMs}ms > 960ms`)
if (coldStart !== null && coldStart > 3000) failures.push(`coldStart=${coldStart}ms > 3000ms`)
if (failures.length > 0) {
  console.error(`bench: 失败\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('bench: 已测门禁通过；portable 冷启动已包含渲染器/桥/持久化验收，未具备的首 token、帧率和跨平台指标已明确列入 skipped。')
}

async function runSessionBenchmark() {
  const tsx = join(root, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const script = join(root, 'apps', 'cli', 'src', 'bench-session.ts')
  const { stdout } = await execFileAsync(process.execPath, [tsx, script], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(stdout)
}

async function runPortableAcceptance() {
  const script = join(root, 'apps', 'desktop', 'scripts', 'smoke-portable.mjs')
  const { stdout } = await execFileAsync(process.execPath, [script, '--json'], { cwd: root, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}
