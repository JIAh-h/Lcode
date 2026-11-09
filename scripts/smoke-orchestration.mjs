/**
 * 真实模型跑一遍跨会话编排（docs/26 P11）。
 *
 * 与单测的区别：**不打桩**。用本机 `~/.lcode` 里配置的默认模型，真的建 Router 会话、
 * 真的让模型决定派发、真的跑 worker、真的汇总。
 *
 * ## 装配顺序（照主进程 `agentRuntime()`）
 *
 * 1. `createDesktopModelFeature()` —— 它负责把 `settings.json` 里的自定义供应商
 *    **注册进 `ctx.llm`**。少了这步会报 `EL-NO_ADAPTER`（第一次跑就踩了）。
 * 2. `createAgentRuntime({ services: feature.services })` —— **必须共享同一个 services**，
 *    否则模型配置写在 A 的 ctx 里、引擎读 B 的 ctx，表现为"配了但没生效"。
 *
 * 用法：
 *   .\node_modules\.bin\tsx.cmd scripts/smoke-orchestration.mjs
 *   .\node_modules\.bin\tsx.cmd scripts/smoke-orchestration.mjs --mode observe
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'auto'

const { createDesktopModelFeature } = await import('../packages/bundle/lcode-desktop/src/index.ts')
const { createAgentRuntime } = await import('../packages/bundle/lcode-desktop/src/agent-runtime.ts')

const realHome = join(homedir(), '.lcode')

/*
 * 直接使用**真实 home**，不复制。
 *
 * 原因：凭据记录存在 `index.db` 的 `credentials_refs` 表里（blob 在 `credentials/`），
 * 只复制 `credentials/` 目录会导致 `EL-CREDENTIAL_MISSING`（第一次跑就踩了）。
 * 拿一份活的 SQLite（含 WAL）复制出来也不安全，所以这里直接用真实 home，
 * 跑完把冒烟建的会话删掉并清空回收站。
 */
const workHome = realHome

console.log('=== 真实编排冒烟 ===')
console.log('mode      :', mode)
console.log('Lcode Home:', workHome)
console.log()

const feature = await createDesktopModelFeature({ home: workHome })
const runtime = await createAgentRuntime({ home: workHome, services: feature.services, orchestrationMode: mode })

const defaultModel = runtime.ctx.get('agentDefaultModel').get()
console.log('已注册供应商:', feature.providers().join(', ') || '(无)')
console.log('默认模型    :', defaultModel?.provider, '/', defaultModel?.model)
console.log('编排档位    :', runtime.orchestration.mode())
console.log()

const t0 = Date.now()

try {
  // ① 建 Router 会话并标记角色
  const { session_id: routerSession } = await runtime.sessions.create({
    cwd: process.cwd(),
    title: '编排冒烟：总协调',
  })
  runtime.sessionRoles.setRole(routerSession, 'router')
  const { agent_id } = await runtime.agents.create({ session_id: routerSession })
  console.log('[1] Router 会话:', routerSession, '| 角色 =', runtime.sessionRoles.roleOf(routerSession))

  // ② 要求模型拆分并派发
  const prompt =
    '用 dispatch_worker 工具派两个 worker，各查一个文件里的常量，不要自己查：\n' +
    '1) packages/core/orchestration-local/src/index.ts 里 REPORT_WINDOW_MS 和 REPORT_COOLDOWN_MS 的值\n' +
    '2) packages/bundle/lcode-desktop/src/watchdog.ts 里巡检默认间隔（intervalMs 缺省值）\n' +
    '每个 worker 的任务描述要自包含（worker 看不到这段对话）。'
  console.log('[2] 要求 Router 拆分并派发…')

  const waitTurnEnd = (sessionId, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('回合超时')), timeoutMs)
      const stop = runtime.watchSession(sessionId, (event) => {
        if (event.type !== 'turn/end') return
        clearTimeout(timer)
        stop()
        resolve(event)
      })
    })

  const firstTurn = waitTurnEnd(routerSession)
  await runtime.agents.followup({ agent_id, content: [{ type: 'text', text: prompt }] })
  await firstTurn

  const routerEvents = () => runtime.sessions.sessionServiceFor(routerSession).events()
  let events = routerEvents()
  const toolCalls = events.filter((e) => e.type === 'tool/call')
  const dispatched = events.filter((e) => e.type === 'worker/dispatched')
  /*
   * `observe` 档下 `worker/dispatched` 也会落，但 `workerSessionId` 是空串——
   * 那是「预演记录」而不是真实派发。分开统计，否则会误以为 worker 被创建了。
   */
  const materialized = dispatched.filter((e) => e.data.workerSessionId !== '')
  const previews = dispatched.length - materialized.length
  console.log('[3] Router 工具调用:', toolCalls.map((e) => e.data.name).join(', ') || '(无)')
  console.log('[4] 派发事件:', dispatched.length, `（真实 ${materialized.length} / 预演 ${previews}）`)

  if (dispatched.length === 0) {
    const lastAssistant = [...events].reverse().find((e) => e.type === 'assistant/message')
    console.log('\n[!] 模型没有派发。它的原话：')
    console.log((lastAssistant?.data?.message?.content ?? []).map((b) => b.text ?? '').join('').slice(0, 600))
    throw new Error('模型未派发 worker（见上方原话）')
  }

  // ③ 等 worker 完成（只有真实派发才需要等；预演没有 worker 可等）
  if (materialized.length === 0) {
    console.log('\n[5] observe 档：没有真实 worker，跳过等待（这就是预期行为）')
  } else {
    console.log('\n[5] 等 worker 完成…')
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      const done = routerEvents().filter((e) => e.type === 'worker/completed')
      if (done.length >= materialized.length) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  events = routerEvents()
  const completed = events.filter((e) => e.type === 'worker/completed')
  console.log('[6] 完成 worker 数:', completed.length, '/', materialized.length)
  for (const c of completed) {
    console.log('    -', c.data.outcome, '|', String(c.data.summary ?? '').replaceAll('\n', ' ').slice(0, 120))
  }

  // ④ 等批处理汇报落地（窗口 200ms + Router 一轮）
  await new Promise((r) => setTimeout(r, 2500))
  events = routerEvents()
  const turns = events.filter((e) => e.type === 'turn/start').length
  /*
   * 汇报条数只数**系统汇报**，不数用户原始指令。
   * 汇报文案带固定前缀（单个是「worker xxx 已完成」，多个是「N 个 worker 已完成」）。
   */
  const reportMsgs = events.filter((e) => {
    if (e.type !== 'user/message') return false
    const text = JSON.stringify(e.data)
    return text.includes('worker') && (text.includes('已完成') || text.includes('已结束') || text.includes('失败'))
  })
  console.log('\n[7] Router 总回合数:', turns, '(理想 2：1 派发 + 1 合并汇报)')
  console.log('[8] 系统汇报条数:', reportMsgs.length, '(理想 1：合并成一条)')

  /*
   * 时间线诊断：批处理窗口只有 200ms，如果两个 worker 的完成时刻间隔更大，
   * 它们就会落进不同的桶，各触发一次唤醒。把时刻打出来才好判断是"实现问题"
   * 还是"场景本来就不该合并"。
   */
  const timeline = events
    .filter((e) => ['worker/dispatched', 'worker/completed', 'turn/start'].includes(e.type))
    .map((e) => ({ t: e.time, type: e.type, id: e.data.taskId ?? '' }))
  const base = timeline[0]?.t ?? 0
  console.log('[8b] 时间线（ms 相对起点）:')
  for (const item of timeline) {
    console.log(`      +${String(item.t - base).padStart(6)}ms  ${item.type}  ${item.id}`)
  }

  // ⑤ 用量（qwen 系部分模型不回 usage，为 0 属正常）
  let totalIn = 0
  let totalOut = 0
  for (const e of events) {
    const usage = e.type === 'assistant/message' ? e.data.usage : undefined
    if (usage === undefined) continue
    totalIn += usage.input ?? 0
    totalOut += usage.output ?? 0
  }
  console.log(
    `[9] Router 侧 token：输入 ${totalIn} / 输出 ${totalOut}` +
      (totalIn + totalOut === 0 ? '（该模型未回传 usage，属正常）' : ''),
  )

  // ⑥ worker 侧 usage
  let workerTokens = 0
  for (const d of materialized) {
    const sid = d.data.workerSessionId
    if (sid === '') continue
    for (const e of runtime.sessions.sessionServiceFor(sid).events()) {
      const usage = e.type === 'assistant/message' ? e.data.usage : undefined
      if (usage === undefined) continue
      workerTokens += (usage.input ?? 0) + (usage.output ?? 0)
    }
  }
  console.log(`[10] worker 侧总 token：${workerTokens}`)

  // 结论：把这次跑出来的关键事实压缩成一句，便于一眼判断
  const verdict =
    materialized.length === 0
      ? `observe 档：记录 ${dispatched.length} 条派发意向，未创建任何 worker（符合预期）`
      : completed.length === materialized.length
        ? `auto 档：${materialized.length} 个 worker 全部完成，Router ${turns} 回合 / ${reportMsgs.length} 条汇报`
        : `auto 档：${completed.length}/${materialized.length} 个 worker 完成（有未收尾的）`
  console.log(`\n[结论] ${verdict}`)
  console.log(`\n=== 冒烟通过（耗时 ${Math.round((Date.now() - t0) / 1000)}s）===`)
} catch (error) {
  console.error('\n=== 冒烟失败 ===')
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  /*
   * 清理：用的是真实 home，要把冒烟建的会话删掉，避免污染侧栏。
   *
   * 顺序很讲究——**必须先让所有回合停下来再删**。否则 Router 的汇报轮还在流式写入，
   * 删会话后它的 `append` 会抛 ES-SESSION_NOT_FOUND（第一次跑就这么崩了）。
   */
  try {
    /*
     * 清理顺序必须照主进程 `lcode:session.delete` 的做法：**先 dispose agent，再删会话**。
     * `agents.dispose` 会 cancel 当前轮并等它收尾；跳过这步直接删，流式回调仍会
     * 往已删除的会话 append，抛 ES-SESSION_NOT_FOUND（前几次跑就崩在这里）。
     */
    const listed = (await runtime.sessions.list({ limit: 30 })).items
    for (const item of listed) {
      if (!(item.title?.startsWith('编排冒烟') || item.title?.startsWith('worker：'))) continue
      const found = await runtime.agents.get({ session_id: item.session_id }).catch(() => null)
      if (found !== null) await runtime.agents.dispose({ agent_id: found.agent_id }).catch(() => {})
      await runtime.sessions.delete({ session_id: item.session_id }).catch(() => {})
    }
  } catch {
    // 清理失败不影响结论
  }
  await runtime.dispose()
  feature.dispose()
  console.log('（冒烟会话已移入回收站，可在设置 → 归档与回收站清理）')
}
