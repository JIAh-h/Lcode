/**
 * Super-agent 轻量验证：看 Router 会不会自己判断要不要派、派几个。
 *
 * ## 与 `stress-orchestration.mjs` 的分工
 *
 * - `stress` 用 4 个维度压并发与汇总，**贵**（一次 200 万输入 token 量级）。
 * - 这个脚本只验证**行为**：Router 收到任务后自动派发、worker 按设计要求回传、
 *   结果汇总回来。3 个 worker 各读一个 6 行的小文件，整轮通常 3 万 token 以内。
 *
 * ## 额度保护（本脚本的重点之一）
 *
 * 监听 `agent/request-error`：一旦出现额度/鉴权类错误（403、insufficient、
 * EL-CREDENTIAL_REJECTED），立刻中止整轮并如实报告"因额度停止"，**不重试不硬撑**。
 * 另外还有两道上限：单轮 token 预算、总时长。
 *
 * 用法：
 *   .\node_modules\.bin\tsx.cmd scripts/smoke-superagent-small.mjs
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const { createDesktopModelFeature } = await import('../packages/bundle/lcode-desktop/src/index.ts')
const { createAgentRuntime } = await import('../packages/bundle/lcode-desktop/src/agent-runtime.ts')

const home = join(homedir(), '.lcode')
const workspace = process.cwd()
/** 这批请求的输入 token 上限：超了就停，避免把额度烧穿 */
const TOKEN_BUDGET = 400_000
/** 总时长上限 */
const DEADLINE_MS = 8 * 60 * 1000

/**
 * 任务刻意做小：三个包、每个只读一个 `package.json` 的前 6 行。
 *
 * 措辞上只说"派 worker 去看"，**不指定数目**——这一轮要观察的正是
 * "Router 自己决定派几个"。同时明确要求 worker 用 `report_to_router` 回传，
 * 以便验证 Worker → Router 这条通道。
 */
const TASK = [
  '帮我看三个小包的依赖情况，**派 worker 去看，你不要自己读文件**，派几个由你判断。',
  '',
  '包的清单（每个 worker 只看它负责的那一个文件，看前 6 行即可）：',
  '1. packages/core/orchestration/package.json',
  '2. packages/core/agent-loop/package.json',
  '3. packages/llm/llm-replay/package.json',
  '',
  '每个 worker 的要求：',
  '- 只读自己那一个文件的前 6 行；',
  '- 数出 dependencies 里有几个是 `workspace:*`；',
  '- **必须调用 report_to_router（kind=done）** 回报结论，摘要里带上文件路径；',
  '- 不要修改任何文件。',
  '',
  '全部回来后，用三行小结告诉我每个包的外部依赖情况。',
].join('\n')

console.log('=== Super-agent 轻量验证 ===')
console.log('工作区:', workspace)
console.log('预算  :', `${TOKEN_BUDGET.toLocaleString()} 输入 token / ${DEADLINE_MS / 60000} 分钟`)
console.log()

const feature = await createDesktopModelFeature({ home })
/*
 * 装配与配置**完全照桌面端**：模型、Router 路由、编排档位都取 Lcode 自己的设置。
 * 脚本不指定模型——一旦脚本自带模型参数，就会和应用跑出两套行为。
 */
const runtime = await createAgentRuntime({ home, services: feature.services })

/** 与主进程一致：`orchestration.defaultMode` 缺省按 auto */
const defaultMode = feature.services.readSetting('orchestration.defaultMode') === 'observe' ? 'observe' : 'auto'

const defaultModel = runtime.ctx.get('agentDefaultModel').get()
const routerModelRaw = feature.services.readSetting('orchestration.routerModel')
const routerModel =
  routerModelRaw === null || typeof routerModelRaw !== 'object'
    ? `${defaultModel?.provider} / ${defaultModel?.model}（跟随默认）`
    : `${routerModelRaw.provider} / ${routerModelRaw.model}`
console.log('worker 模型:', defaultModel?.provider, '/', defaultModel?.model)
console.log('Router 模型:', routerModel)
console.log('新建编排会话档位:', defaultMode)
console.log()

// ── 额度/鉴权错误监听：命中即中止 ──
let fatal = null
const unlistenError = runtime.ctx.on('agent/request-error', (payload) => {
  const error = payload.error
  const text = error instanceof Error ? `${error.message}` : String(error)
  const code = typeof error === 'object' && error !== null ? String(error.code ?? '') : ''
  if (/403|insufficient|quota|exhausted|EL-CREDENTIAL_REJECTED|invalid_api_key/i.test(`${text} ${code}`)) {
    fatal = `额度或鉴权错误：${text.slice(0, 160)}`
  }
})

const t0 = Date.now()
let totalInput = 0
let totalCache = 0
let routerSession = ''
const cleanups = []

try {
  // ① 建 Router 会话（等价于桌面端勾选「作为编排调度会话」）
  const created = await runtime.sessions.create({ cwd: workspace, title: '轻量验证：总协调' })
  routerSession = created.session_id
  runtime.sessionRoles.setRole(routerSession, 'router', '轻量验证')
  // 与桌面端新建编排会话一致：档位取设置里的 `orchestration.defaultMode`
  runtime.orchestration.setMode(defaultMode, '轻量验证', routerSession)
  const { agent_id } = await runtime.agents.create({ session_id: routerSession })
  const events = () => runtime.sessions.sessionServiceFor(routerSession).events()
  console.log('[1] Router 会话:', routerSession, '| 档位 =', runtime.orchestration.modeFor(routerSession))

  // ② 下发任务
  console.log('[2] 下发任务，观察 Router 是否自行派发…')
  await runtime.agents.followup({ agent_id, content: [{ type: 'text', text: TASK }] })

  /** 轮询：直到没有在跑的 worker 且 Router 安静下来，或触发上限 */
  async function pump(label, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastCount = -1
    let lastChange = Date.now()
    while (Date.now() < deadline) {
      if (fatal !== null) throw new Error(fatal)
      if (Date.now() - t0 > DEADLINE_MS) throw new Error('总时长超限，中止')
      if (totalInput > TOKEN_BUDGET) throw new Error(`输入 token 已超预算 ${TOKEN_BUDGET}，中止`)

      const list = runtime.orchestration.list({ routerSessionId: routerSession })
      const running = list.filter((w) => w.state === 'running').length
      const count = events().length
      if (running === 0 && count === lastCount && Date.now() - lastChange >= 6000) return
      if (count !== lastCount) {
        lastCount = count
        lastChange = Date.now()
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`等待「${label}」超时`)
  }

  await pump('派发与汇总', 300_000)

  // ③ 结果
  const evs = events()
  const dispatched = evs.filter((e) => e.type === 'worker/dispatched' && e.data.workerSessionId !== '')
  const reported = evs.filter((e) => e.type === 'worker/reported')
  const completed = evs.filter((e) => e.type === 'worker/completed')
  const toolNames = evs.filter((e) => e.type === 'tool/call').map((e) => e.data.name)
  const turns = evs.filter((e) => e.type === 'turn/start').length

  const addUsage = (list) => {
    for (const e of list) {
      if (e.type !== 'assistant/message') continue
      const u = e.data.usage
      if (!u) continue
      totalInput += u.input ?? 0
      totalCache += u.cacheRead ?? 0
    }
  }
  addUsage(evs)
  for (const d of dispatched) addUsage(runtime.sessions.sessionServiceFor(d.data.workerSessionId).events())

  console.log('\n=== 结果 ===')
  console.log(`总耗时        : ${Math.round((Date.now() - t0) / 1000)}s`)
  console.log(`Router 工具调用: ${toolNames.length} 次 → ${toolNames.join(', ') || '(无)'}`)
  console.log(`派发 worker 数: ${dispatched.length}（由 Router 自行决定）`)
  for (const d of dispatched) {
    console.log(`   - ${d.data.taskId} → ${d.data.workerSessionId.slice(0, 10)}… | ${String(d.data.task).replaceAll('\n', ' ').slice(0, 56)}`)
  }
  console.log(`完成事件      : ${completed.length}`)
  console.log(`worker 主动回传: ${reported.length} 次（report_to_router）`)
  for (const r of reported) {
    console.log(`   - kind=${r.data.kind} | ${String(r.data.summary ?? '').replaceAll('\n', ' ').slice(0, 80)}`)
  }
  console.log(`Router 回合数 : ${turns}`)
  console.log(
    `token         : 输入 ${totalInput.toLocaleString()}｜命中缓存 ${totalCache.toLocaleString()}（${totalInput === 0 ? 'n/a' : Math.round((totalCache / totalInput) * 100) + '%'}）`,
  )

  console.log('\n--- Router 最终汇总 ---')
  const last = [...evs].reverse().find((e) => e.type === 'assistant/message')
  console.log((last?.data.message.content ?? []).map((b) => b.text ?? '').join('') || '(空)')

  // ④ 判定
  const checks = [
    ['Router 自动派发', dispatched.length > 0],
    ['worker 全部完成', completed.length >= dispatched.length && dispatched.length > 0],
    ['worker 主动回传', reported.length > 0],
    ['Router 有汇总', (last?.data.message.content ?? []).length > 0],
  ]
  console.log('\n--- 判定 ---')
  for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  const allOk = checks.every(([, ok]) => ok)
  console.log(`\n[结论] ${allOk ? '通过' : '未全部通过'}`)
  if (!allOk) process.exitCode = 1
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const byQuota = /额度|403|insufficient|quota|exhausted|CREDENTIAL/i.test(message)
  console.error(`\n=== ${byQuota ? '因额度/鉴权问题停止测试' : '测试中止'} ===`)
  console.error(message)
  process.exitCode = byQuota ? 2 : 1
} finally {
  unlistenError()
  // 清理：先 dispose agent 再删会话（与主进程顺序一致）
  try {
    const listed = (await runtime.sessions.list({ limit: 40 })).items
    for (const item of listed) {
      if (!(item.title?.startsWith('轻量验证') || item.title?.startsWith('worker：'))) continue
      const found = await runtime.agents.get({ session_id: item.session_id }).catch(() => null)
      if (found !== null) await runtime.agents.dispose({ agent_id: found.agent_id }).catch(() => {})
      await runtime.sessions.delete({ session_id: item.session_id }).catch(() => {})
    }
  } catch {
    // 清理失败不影响结论
  }
  for (const fn of cleanups) fn()
  await runtime.dispose()
  feature.dispose()
}
