/**
 * Super-agent 压测：一个必须派发多个 worker 才能完成的复杂任务（docs/26 P11）。
 *
 * ## 与 smoke 的区别
 *
 * `smoke-orchestration.mjs` 验证"链路通不通"（派 2 个、查两个常量）。
 * 这个脚本验证"**能不能扛住真实复杂度**"：4 个互不依赖的审计维度、真实读代码、
 * 真实并发、真实汇总。它同时是 Router 判断力的测试——Router 用的是什么模型，
 * 就直接决定它会不会拆、拆几个。
 *
 * ## 任务设计原则
 *
 * 1. **必须拆**：4 个维度分布在 4 个互不相干的包里，单 worker 串行也能做，
 *    但那不是"派发"要证明的事——所以提示里明确要求不许自己读。
 * 2. **可验证**：每个 worker 必须给 `文件:行号` 证据。跑完能抽查它是不是真读了代码，
 *    而不是编一段像模像样的话。
 * 3. **有汇总价值**：4 份结果要能合成一份带优先级的报告，这是 Router 的本职。
 *
 * 用法：
 *   .\node_modules\.bin\tsx.cmd scripts/stress-orchestration.mjs
 *   .\node_modules\.bin\tsx.cmd scripts/stress-orchestration.mjs --rounds 2
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const roundsIndex = process.argv.indexOf('--rounds')
const rounds = roundsIndex >= 0 ? Number(process.argv[roundsIndex + 1]) || 1 : 1

const { createDesktopModelFeature } = await import('../packages/bundle/lcode-desktop/src/index.ts')
const { createAgentRuntime } = await import('../packages/bundle/lcode-desktop/src/agent-runtime.ts')

const workHome = join(homedir(), '.lcode')
const workspace = process.cwd()

/**
 * 压测任务：4 个维度必须并行调研。
 *
 * 刻意写成"派驻 4 个"，而不是"看需要派几个"——这一轮要压的是并发与汇总，
 * 不是让 Router 自己决定规模（那另有一轮观察）。
 */
const TASK = [
  '这是一个需要并行调研的审计任务。请派 4 个 worker 分别独立审计 Lcode 仓库的 4 个维度，',
  '**你不要自己去读代码**，一律用 dispatch_worker 派发；每个任务描述必须自包含（worker 看不到这段对话）。',
  '',
  '维度一：编排的并发与资源释放',
  '  范围：packages/core/orchestration-local/src/index.ts',
  '  关注：并发上限怎么算的、worker 回合结束后 agent 有没有释放、失败路径会不会漏收尾。',
  '',
  '维度二：会话角色投影与索引迁移',
  '  范围：packages/session-persistence/session-persistence-sqlite/src/ddl.ts、migrations.ts、project.ts',
  '  关注：role 列怎么从事件派生、老索引（v1）升到 v2 时旧数据怎么办、重建索引是否一致。',
  '',
  '维度三：引擎的取消语义与引擎复用',
  '  范围：packages/core/agent-loop/src/engine.ts、agent-loop.ts',
  '  关注：两级 AbortSignal 的作用范围、dispose 之后 resume 会怎样、队列里的输入怎么处理。',
  '',
  '维度四：桌面端编排 IPC 契约',
  '  范围：apps/desktop/electron/main.ts、apps/desktop/electron/preload.ts',
  '  关注：编排相关的几个 handler 各自的契约、参数校验有没有漏洞、渲染层能拿到什么。',
  '',
  '每个 worker 的输出要求：',
  '- 3~5 条具体发现，每条必须带 `文件:行号` 证据；',
  '- 最后指出该维度**最严重的一个风险**，并说明后果；',
  '- 不要修改任何文件，这是只读审计。',
  '',
  '全部完成后，把 4 份结果合成一份报告：按严重程度排序，并说明你派了几个 worker。',
].join('\n')

console.log('=== Super-agent 压测 ===')
console.log('工作区    :', workspace)
console.log('Lcode Home:', workHome)
console.log('轮次      :', rounds)
console.log()

const feature = await createDesktopModelFeature({ home: workHome })
/*
 * 模型与 Router 路由**全部取自 Lcode 自己的配置**（settings.json）。
 *
 * 不在脚本里指定模型：脚本一旦自带模型参数，就会和桌面端跑出两套行为，
 * "压测通过但应用里不一样"这种结论毫无价值。
 */
const runtime = await createAgentRuntime({ home: workHome, services: feature.services })

/** 与主进程一致：`orchestration.defaultMode` 缺省按 auto */
const defaultMode = feature.services.readSetting('orchestration.defaultMode') === 'observe' ? 'observe' : 'auto'

const defaultModel = runtime.ctx.get('agentDefaultModel').get()
const routerModelRaw = feature.services.readSetting('orchestration.routerModel')
console.log('默认模型（worker 用）:', defaultModel?.provider, '/', defaultModel?.model)
console.log(
  'Router 模型          :',
  routerModelRaw === null || typeof routerModelRaw !== 'object'
    ? '(跟随默认模型)'
    : `${routerModelRaw.provider} / ${routerModelRaw.model}`,
)
console.log('并发上限            : 8（缺省）')
console.log()

/** 轮询直到条件成立，超时抛错。 */
async function waitFor(label, predicate, timeoutMs, intervalMs = 800) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`等待「${label}」超时（${Math.round(timeoutMs / 1000)}s）`)
}

/**
 * 等会话"安静下来"：连续 `quietMs` 没有新事件。
 *
 * 为什么需要它：汇总轮可能分好几次（每收到一批汇报就说一段），
 * 用"事件数 > 某个值"之类的条件判断早晚会错。**没有新事件**才是不依赖
 * 事件顺序的稳定判据。
 */
async function waitQuiet(sessionId, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastCount = -1
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    const count = runtime.sessions.sessionServiceFor(sessionId).events().length
    if (count !== lastCount) {
      lastCount = count
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      return
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('等待会话安静超时')
}

const sessionsToClean = []

try {
  for (let round = 1; round <= rounds; round += 1) {
    console.log(`\n──────────── 第 ${round}/${rounds} 轮 ────────────`)
    const t0 = Date.now()

    // ① 建 Router 会话：角色 + 按会话档位（与桌面端「勾选编排调度会话」等价）
    const { session_id: routerSession } = await runtime.sessions.create({
      cwd: workspace,
      title: `压测第${round}轮：总协调`,
    })
    sessionsToClean.push(routerSession)
    runtime.sessionRoles.setRole(routerSession, 'router', '压测')
    runtime.orchestration.setMode(defaultMode, '压测', routerSession)
    const { agent_id } = await runtime.agents.create({ session_id: routerSession })
    const events = () => runtime.sessions.sessionServiceFor(routerSession).events()
    console.log('[1] Router 会话:', routerSession, '| 档位 =', runtime.orchestration.modeFor(routerSession))

    // ② 下发任务，等 Router 第一轮（判断 + 派发）结束
    console.log('[2] 下发复杂任务，等 Router 拆分…')
    await runtime.agents.followup({ agent_id, content: [{ type: 'text', text: TASK }] })
    await waitFor('Router 首轮结束', () => events().some((e) => e.type === 'turn/end'), 240_000, 1000)

    const dispatched = events().filter((e) => e.type === 'worker/dispatched')
    const materialized = dispatched.filter((e) => e.data.workerSessionId !== '')
    const toolCalls = events().filter((e) => e.type === 'tool/call').map((e) => e.data.name)
    console.log(`[3] Router 工具调用（${toolCalls.length} 次）:`, toolCalls.join(', ') || '(无)')
    console.log(`[4] 派发 worker 数: ${materialized.length}（预期 4）`)
    for (const d of materialized) {
      console.log(`    - ${d.data.taskId} → ${d.data.workerSessionId} | ${String(d.data.task).replaceAll('\n', ' ').slice(0, 70)}`)
    }

    if (materialized.length === 0) {
      const last = [...events()].reverse().find((e) => e.type === 'assistant/message')
      console.log('\n[!] Router 没有派发。它的原话：')
      console.log((last?.data?.message?.content ?? []).map((b) => b.text ?? '').join('').slice(0, 800))
      throw new Error('Router 未派发 worker')
    }

    // ③ 压测：观察并发峰值 + 等全部完成
    console.log('\n[5] 观察并发与等待完成…')
    let peak = 0
    /*
     * 用编排服务的状态判断，而不是数日志里的完成事件：
     * Router 可能在派发后又补派（失败重试），日志条数会变；而"有没有在跑的 worker"
     * 是权威状态。
     */
    await waitFor(
      '全部 worker 收尾',
      () => {
        const list = runtime.orchestration.list({ routerSessionId: routerSession })
        const running = list.filter((w) => w.state === 'running').length
        peak = Math.max(peak, running)
        return list.length > 0 && running === 0
      },
      600_000,
      400,
    )
    // 再从日志里取一次完整清单（含后续补派的）
    const allDispatched = events().filter((e) => e.type === 'worker/dispatched' && e.data.workerSessionId !== '')
    const workerIds = allDispatched.map((d) => d.data.workerSessionId)
    const completed = events().filter((e) => e.type === 'worker/completed')
    console.log(`[6] 最终派发 ${allDispatched.length} 个，完成事件 ${completed.length} 条，并发峰值 ${peak}`)
    // 完成事件条数与派发数不一致时要能看出是哪些 taskId 重复了
    const perTask = new Map()
    for (const c of completed) perTask.set(c.data.taskId, (perTask.get(c.data.taskId) ?? 0) + 1)
    const dup = [...perTask.entries()].filter(([, n]) => n > 1)
    if (dup.length > 0) console.log('    ⚠ 同一任务出现多条完成事件:', dup.map(([t, n]) => `${t}×${n}`).join(', '))

    // ④ 等 Router 真正安静下来（汇总可能分几段说）
    console.log('[7] 等 Router 汇总（以"连续无新事件"为判据）…')
    await waitQuiet(routerSession, 8000, 240_000)

    // ⑤ 汇总指标
    const evs = events()
    const turns = evs.filter((e) => e.type === 'turn/start').length
    const reports = evs.filter((e) => {
      if (e.type !== 'user/message') return false
      const text = JSON.stringify(e.data)
      return text.includes('worker') && /已完成|已结束|失败|被取消|需要你的决定/.test(text)
    })
    const usage = (list) =>
      list.reduce(
        (acc, e) => {
          const u = e.type === 'assistant/message' ? e.data.usage : undefined
          if (u === undefined) return acc
          return {
            input: acc.input + (u.input ?? 0),
            output: acc.output + (u.output ?? 0),
            // 缓存命中的输入 token：这是"钱花在哪"的关键指标（官方实验也是看它）
            cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
          }
        },
        { input: 0, output: 0, cacheRead: 0 },
      )
    const routerUsage = usage(evs)
    let workerUsage = { input: 0, output: 0, cacheRead: 0 }
    let workerToolCalls = 0
    for (const sid of workerIds) {
      const wevs = runtime.sessions.sessionServiceFor(sid).events()
      workerToolCalls += wevs.filter((e) => e.type === 'tool/call').length
      const u = usage(wevs)
      workerUsage = {
        input: workerUsage.input + u.input,
        output: workerUsage.output + u.output,
        cacheRead: workerUsage.cacheRead + u.cacheRead,
      }
    }
    const hitRate = (u) => (u.input === 0 ? 'n/a（模型未回传 usage）' : `${Math.round((u.cacheRead / u.input) * 100)}%`)

    console.log('\n=== 第 ' + round + ' 轮结果 ===')
    console.log(`总耗时      : ${Math.round((Date.now() - t0) / 1000)}s`)
    console.log(`Router 回合 : ${turns}（1 派发 + 1 汇总为理想值）`)
    console.log(`汇报条数    : ${reports.length}（4 个 worker 合并成几条）`)
    console.log(`并发峰值    : ${peak}`)
    console.log(`worker 工具调用总数: ${workerToolCalls}`)
    console.log(
      `token      : Router 输入${routerUsage.input}/输出${routerUsage.output}/缓存命中${routerUsage.cacheRead}（命中率 ${hitRate(routerUsage)}）`,
    )
    console.log(
      `             worker 输入${workerUsage.input}/输出${workerUsage.output}/缓存命中${workerUsage.cacheRead}（命中率 ${hitRate(workerUsage)}）`,
    )

    // ⑥ 抽查：每个 worker 是否真的读了代码（不是编的）
    console.log('\n[8] 逐 worker 抽查：')
    for (const [i, sid] of workerIds.entries()) {
      const wevs = runtime.sessions.sessionServiceFor(sid).events()
      const readCalls = wevs.filter((e) => e.type === 'tool/call' && ['read', 'grep', 'glob'].includes(e.data.name)).length
      const allToolCalls = wevs.filter((e) => e.type === 'tool/call').length
      const workerTurns = wevs.filter((e) => e.type === 'turn/start').length
      const workerEnd = wevs.filter((e) => e.type === 'turn/end')
      const computed = events().find(
        (e) => e.type === 'worker/completed' && e.data.workerSessionId === sid,
      )
      const outcome = computed?.data?.outcome ?? '(无完成事件)'
      const err = computed?.data?.error
      const lastAssistant = [...wevs].reverse().find((e) => e.type === 'assistant/message')
      const text = (lastAssistant?.data?.message?.content ?? []).map((b) => b.text ?? '').join('')
      const hasEvidence = /:\d+/.test(text)
      const elapsed = workerEnd[0] && wevs[0] ? Math.round((workerEnd[0].time - wevs[0].time) / 1000) : '?'
      console.log(
        `    worker${i + 1} ${sid.slice(0, 8)}… outcome=${outcome} | 轮${workerTurns} 工具${allToolCalls}(读${readCalls}) | ${elapsed}s | 行号证据:${hasEvidence ? 'YES' : 'NO'} | 末条文本${text.length}字`,
      )
      if (err !== undefined) console.log(`      ⚠ 错误: ${String(err).slice(0, 160)}`)
      if (text.trim() === '') {
        const lastStep = [...wevs].reverse().find((e) => e.type === 'step/end')
        console.log(`      （末条 assistant 文本为空；最后一步 reason=${lastStep?.data?.reason ?? '?'}）`)
      }
    }

    // ⑦ Router 的最终报告（全文，别截断——压测要看的正是它汇总得好不好）
    const lastRouter = [...evs].reverse().find((e) => e.type === 'assistant/message')
    const finalText = (lastRouter?.data?.message?.content ?? []).map((b) => b.text ?? '').join('')
    console.log('\n[9] Router 最终汇总:')
    console.log(finalText || '(空)')

    // 汇总质量粗检：4 个维度是否都被覆盖到（搜全部 assistant 文本，不只看最后一条）
    const allRouterText = evs
      .filter((e) => e.type === 'assistant/message')
      .flatMap((e) => (e.data.message?.content ?? []).map((b) => b.text ?? ''))
      .join('\n')
    const dims = ['维度一', '维度二', '维度三', '维度四']
    const covered = dims.filter((d) => allRouterText.includes(d))
    console.log(`\n[10] Router 全文覆盖维度: ${covered.length}/4 ${covered.join(' ')}`)

    const ok = completed.length === materialized.length && materialized.length >= 2
    console.log(`\n[判定] ${ok ? '通过' : '未达预期'}：派发 ${materialized.length}、完成 ${completed.length}、汇报 ${reports.length}`)
  }
} catch (error) {
  console.error('\n=== 压测失败 ===')
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  /*
   * 清理：用的是真实 home，必须把压测建的会话删掉。
   * 顺序照主进程：**先 dispose agent，再删会话**，否则流式回调会往已删会话 append。
   */
  try {
    const listed = (await runtime.sessions.list({ limit: 60 })).items
    for (const item of listed) {
      if (!(item.title?.startsWith('压测') || item.title?.startsWith('worker：'))) continue
      const found = await runtime.agents.get({ session_id: item.session_id }).catch(() => null)
      if (found !== null) await runtime.agents.dispose({ agent_id: found.agent_id }).catch(() => {})
      await runtime.sessions.delete({ session_id: item.session_id }).catch(() => {})
    }
  } catch {
    // 清理失败不影响结论
  }
  await runtime.dispose()
  feature.dispose()
  console.log('\n（压测会话已移入回收站，可在 设置 → 归档与回收站 清理）')
}
