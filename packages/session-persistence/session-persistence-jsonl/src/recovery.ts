import { asSeq, nowEpochMs } from '@lcode/util'
import type { SessionEvent } from '@lcode/session'
import type { EventFrame } from './jsonl.ts'

/**
 * 崩溃恢复（文档 11 §6 / 06 §9；实施计划 T6.1）。
 *
 * **逐条为准的契约**（11 §6.1 四条规则 + §6.3 恢复流程）：
 *
 * | # | 规则 | 行为 |
 * |---|---|---|
 * | R1 | 只丢弃撕裂的最后一条记录 | 由 `loader` 完成（`LoadedLog.tornTailDiscarded`），本模块**不再丢弃任何东西** |
 * | R2 | 保留完整的中断轮 | 不删任何已完整写入的 `turn/start` / `step/start` / `tool/call` |
 * | R3 | 合成收尾事件 | 为未配对 `tool/call` 补 `tool/result`；补未闭合 `step/end`、`turn/end` |
 * | R4 | 版本/损坏分流 | 由 `loader` 完成（`ES-CORRUPTED` / `ES-FORMAT_UNSUPPORTED`） |
 *
 * **顺序不能变**（11 §6.3「关键顺序」）：先补 `tool/result` → 再补 `step/end` → 最后补 `turn/end`。
 * 因为闭合是有层次的——工具结果先配对，步才能关，轮才能关。
 *
 * **为什么不能直接丢弃中断的轮**（11 §6.2）：模型 API 硬要求每条 assistant 消息里的
 * `tool_call` 都有配对 `tool_result`，否则下一次请求直接 400。丢弃只会把"半截历史"变成
 * "非法历史"。所以正确做法是**保留 + 补一条诚实的收尾**（`ABORTED_BEFORE_DISPATCH`，
 * 明确表示未派发，因此不能假设有副作用）。
 *
 * **幂等**（11 §6.1 末）：对已经恢复过的日志再跑一次，不产出任何 closers——
 * 这是可测试的不变量。
 *
 * 本模块是**纯函数、不做 I/O**，且在**帧（`EventFrame`）**上工作而不在事件上：
 * 帧是日志里的真实形态，恢复的产物要直接写回日志，中间不必经过 `SessionEvent` 的类型断言。
 * 产出帧的 `seq` 全部填 **-1**——它们必须由调用方按"当前日志长度"重新编号，
 * 绝不能被原样写进日志（那会直接违反不变量 I2）。
 */

/** `tool/result` 在未派发时携带的错误码（21 §6.2 `ET-ABORTED_BEFORE_DISPATCH`） */
export const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

/** 恢复补出来的收尾事件用的错误码（21 §6.2 `ES-RECOVERY_REPAIRED`，通知性结果而非错误） */
export const RECOVERY_REPAIRED = 'ES-RECOVERY_REPAIRED'

/** 合成收尾时写进 `tool/result.message.content` 的文本 */
export const ABORTED_RESULT_TEXT = 'Error: tool call aborted before dispatch'

/** `turn/end` 在崩溃恢复时的原因（22 §6.2 `TurnEndReason` 的 `aborted`） */
export const ABORTED_TURN_REASON = 'aborted'

/**
 * 恢复补记的耗时上限（ms）。`time` 必须单调不减（22 §7.6），但恢复可能发生在崩溃很久之后——
 * 直接写 `now` 会让"补的一条"排在时间轴上很远的未来，与它实际所属的那一轮脱节。
 * 因此取 `min(now, 上一条 time + 上限)`：既不破坏单调性，也不把补记推到未来。
 *
 * 取 60s 而非 1ms：补记与崩溃之间允许有一个"同一分钟内"的合理间隔，
 * 时间轴上看起来仍像同一次中断的收尾，而不是与正文差一毫秒的噪声。
 */
export const MAX_REPAIR_GAP_MS = 60_000

/**
 * 不闭合结构的扫描结果。
 * 导出它是为了让调用方（UI / doctor）能只做判定而不合成。
 */
export interface OpenStructures {
  /** 打开但未闭合的轮（`turn/start` 无配对 `turn/end`）；`null` 表示没有 */
  readonly openTurn: number | null
  /** 打开的步；`null` 表示没有 */
  readonly openStep: { readonly turn: number; readonly step: number } | null
  /** 有 `tool/call` 但无配对 `tool/result` 的调用（按出现顺序） */
  readonly unpairedToolCalls: readonly UnpairedToolCall[]
}

export interface UnpairedToolCall {
  readonly callId: string
  readonly name: string
  /** 该调用所属的轮与步（合成 `tool/result` 的 data 需要） */
  readonly turn: number
  readonly step: number
}

export interface RecoveryResult {
  /** 补出来的收尾帧（**不含**原事件；`seq` 为 -1，须由调用方重新编号） */
  readonly closers: readonly EventFrame[]
  /** 是否补过东西 */
  readonly repaired: boolean
  /** 扫描出的不闭合结构（诊断用） */
  readonly open: OpenStructures
}

interface FrameData {
  readonly type: string
  readonly data: unknown
}

/**
 * 扫描不闭合结构（纯函数，不合成）。
 *
 * 一轮已闭合（`openTurn === null`）时不再报未配对的工具调用——真实闭环里
 * `turn/end` 之后不可能再执行工具，此时若仍有孤儿 `tool/call`，它属于**上一世**
 * （生命周期分界线之前的残骸），不是本次崩溃的欠账（11 §7.2）。
 */
export function findOpenStructures(frames: readonly FrameData[]): OpenStructures {
  let openTurn: number | null = null
  let openStep: { turn: number; step: number } | null = null
  const pending = new Map<string, UnpairedToolCall>()
  const order: string[] = []

  for (const frame of frames) {
    switch (frame.type) {
      case 'turn/start':
        openTurn = (frame.data as { turn: number }).turn
        break
      case 'turn/end':
        openTurn = null
        // 轮已闭合：残留的孤儿 tool/call 属于上一世，不再算欠账
        pending.clear()
        order.length = 0
        break
      case 'step/start': {
        const d = frame.data as { turn: number; step: number }
        openStep = { turn: d.turn, step: d.step }
        break
      }
      case 'step/end':
        openStep = null
        break
      case 'tool/call': {
        const d = frame.data as { callId: string; name: string; turn: number; step: number }
        if (!pending.has(d.callId)) order.push(d.callId)
        pending.set(d.callId, { callId: d.callId, name: d.name, turn: d.turn, step: d.step })
        break
      }
      case 'tool/result': {
        const d = frame.data as { message?: { toolCallId?: string } }
        const callId = d.message?.toolCallId
        if (callId !== undefined && pending.delete(callId)) {
          const at = order.indexOf(callId)
          if (at >= 0) order.splice(at, 1)
        }
        break
      }
      default:
        // 事件词汇表是开放的（06 §2.3）：插件事件一律不参与闭合判定
        break
    }
  }

  const unpairedToolCalls = order
    .map((callId) => pending.get(callId))
    .filter((call): call is UnpairedToolCall => call !== undefined)

  return { openTurn, openStep, unpairedToolCalls }
}

/**
 * 合成收尾帧（纯函数）。
 *
 * `lastTime` 是日志最后一条事件的 `time`（保持单调），`now` 是当前时刻。
 * 返回的帧 `seq: -1` —— 调用方负责按日志长度重编号（见 `applyRecovery`）。
 */
export function synthesizeClosers(
  frames: readonly FrameData[],
  now: number,
  lastTime?: number,
): RecoveryResult {
  const open = findOpenStructures(frames)
  // 没有显式给出锚点就退到 `now`：补记只要求 time 单调不减，
  // 而"最后一条事件的时间"在撕裂尾场景下未必等于磁盘最后一条（那条已被丢弃）。
  const anchor = lastTime ?? now
  const repairTime = Math.min(now, anchor + MAX_REPAIR_GAP_MS)
  const closers: EventFrame[] = []

  // ① 先补未派发的工具结果（必须排在最前，见 11 §6.3 的关键顺序）
  for (const call of open.unpairedToolCalls) {
    closers.push({
      type: 'tool/result',
      seq: -1,
      time: repairTime,
      data: {
        turn: call.turn,
        step: call.step,
        message: {
          role: 'user',
          toolCallId: call.callId,
          content: [{ type: 'text', text: ABORTED_RESULT_TEXT }],
          isError: true,
        },
        error: { name: 'AbortedBeforeDispatch', code: ABORTED_BEFORE_DISPATCH },
        // 06 §9.4：补记必须"可区分"——UI 据此在时间轴上标注"此处为恢复时补全"
        meta: { card: 'generic', repaired: true },
      },
    })
  }

  // ② 再补步边界
  if (open.openStep !== null) {
    closers.push({
      type: 'step/end',
      seq: -1,
      time: repairTime,
      data: { turn: open.openStep.turn, step: open.openStep.step },
    })
  }

  // ③ 最后补轮边界（reason = aborted：明确这是恢复补的，不是真实结束）
  if (open.openTurn !== null) {
    closers.push({
      type: 'turn/end',
      seq: -1,
      time: repairTime,
      data: { turn: open.openTurn, reason: ABORTED_TURN_REASON },
    })
  }

  return { closers, repaired: closers.length > 0, open }
}

/**
 * 恢复整段日志：合成收尾 + 追加生命周期分界线（11 §6.3 / §7.2）。
 *
 * 返回的是**要追加的帧列表**（收尾帧 + `session/end-seed`），不是完整历史——
 * 调用方按序写回日志即可。`session/end-seed` 只在真的做了修复时追加：
 * 它是"上一世到此为止"的声明，无事发生就不该多写一条。
 *
 * `lastTime` 是日志最后一条事件的时间，用来把补记贴在"崩溃时刻"附近而不是"恢复时刻"
 * （11 要求 `time` 单调，但没有理由让恢复补出的收尾排进未来）。省略则退到 `now`。
 *
 * **幂等**：对一个已经恢复过的日志再调用，`closers` 为空、也不会再追加 end-seed。
 */
export function planRecovery(
  frames: readonly FrameData[],
  now: number = nowEpochMs(),
  lastTime?: number,
): RecoveryResult {
  const result = synthesizeClosers(frames, now, lastTime)
  if (!result.repaired) return result
  const tail = result.closers[result.closers.length - 1]!
  return {
    ...result,
    closers: [
      ...result.closers,
      // 生命周期分界线（11 §7.2）：空载荷，靠位置表达含义
      { type: 'session/end-seed', seq: -1, time: tail.time, data: {} },
    ],
  }
}

/**
 * 给补记帧编号（纯函数）。
 *
 * `startSeq` 必须由调用方给出——它**不是** `frames.length`：撕裂尾场景下磁盘帧数
 * 比可用事件数多一条（被丢弃的那条），补记要接的是**保留下来**的事件之后。
 * `time` 同样保证单调不减（补记晚于崩溃，但不能倒流）。
 *
 * 返回新的帧数组与补上的帧（后者可回执给 UI）。
 */
export function appendClosers(
  frames: readonly EventFrame[],
  closers: readonly EventFrame[],
  startSeq: number,
): { readonly frames: EventFrame[]; readonly appended: EventFrame[] } {
  if (closers.length === 0) return { frames: [...frames], appended: [] }
  const appended: EventFrame[] = []
  let seq = startSeq
  let lastTime = frames.length === 0 ? 0 : frames[frames.length - 1]!.time
  for (const closer of closers) {
    const time = Math.max(closer.time, lastTime)
    appended.push({ ...closer, seq, time })
    lastTime = time
    seq += 1
  }
  return { frames: [...frames, ...appended], appended }
}

/** 帧 → 事件（读侧边界；`type` 是 string，插件可扩展，06 §2.3） */
export function framesToEvents(frames: readonly EventFrame[]): SessionEvent[] {
  return frames.map(
    (frame): SessionEvent => ({ ...frame, seq: asSeq(frame.seq) }) as unknown as SessionEvent,
  )
}
