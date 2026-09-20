import { describe, expect, it } from 'vitest'
import type { EventFrame } from './jsonl.ts'
import {
  ABORTED_BEFORE_DISPATCH,
  MAX_REPAIR_GAP_MS,
  appendClosers,
  findOpenStructures,
  planRecovery,
  synthesizeClosers,
} from './recovery.ts'

/**
 * T6.1 恢复**纯函数**的单测（docs/24 §5 阶段 6）。
 *
 * 这里只测判定与合成，不碰磁盘——落盘与端到端行为在
 * `packages/api/session-api/src/recovery.test.ts` 里验。分开的理由：判定逻辑是
 * 最容易出错、也最值得穷举的部分（各种半闭合组合），用纯函数测可以任意构造形态，
 * 不必为每种组合准备一份日志文件。
 */

const NOW = 1_000_000

function ev(type: string, seq: number, data: unknown, time = seq * 10): EventFrame {
  return { type, seq, time, data }
}

describe('T6.1 纯函数：不闭合结构判定', () => {
  it('完全闭合 → 没有任何未闭合结构，也不补任何事件', () => {
    const frames = [
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 1, { turn: 1, step: 1 }),
      ev('tool/call', 2, {
        turn: 1,
        step: 1,
        callId: 'a',
        name: 'read',
        arguments: '{}',
      }),
      ev('tool/result', 3, { turn: 1, step: 1, message: { toolCallId: 'a' } }),
      ev('step/end', 4, { turn: 1, step: 1 }),
      ev('turn/end', 5, { turn: 1, reason: 'completed' }),
    ]
    expect(findOpenStructures(frames)).toMatchObject({
      openTurn: null,
      openStep: null,
      unpairedToolCalls: [],
    })
    const result = planRecovery(frames, NOW)
    expect(result.repaired).toBe(false)
    expect(result.closers).toEqual([])
  })

  it('多个未配对调用 → 全部列出，且保持出现顺序', () => {
    const frames = [
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 1, { turn: 1, step: 1 }),
      ev('tool/call', 2, {
        turn: 1,
        step: 1,
        callId: 'a',
        name: 'read',
        arguments: '{}',
      }),
      ev('tool/call', 3, {
        turn: 1,
        step: 1,
        callId: 'b',
        name: 'glob',
        arguments: '{}',
      }),
      ev('tool/result', 4, { turn: 1, step: 1, message: { toolCallId: 'a' } }),
    ]
    const open = findOpenStructures(frames)
    expect(open.unpairedToolCalls.map((c) => c.callId)).toEqual(['b'])
    expect(open.unpairedToolCalls[0]).toMatchObject({
      name: 'glob',
      turn: 1,
      step: 1,
    })
  })

  it('轮已闭合 → 孤儿 tool/call 不算欠账（上一世残骸，11 §7.2）', () => {
    const frames = [
      ev('turn/start', 0, { turn: 1 }),
      ev('tool/call', 1, {
        turn: 1,
        step: 1,
        callId: 'stale',
        name: 'read',
        arguments: '{}',
      }),
      ev('turn/end', 2, { turn: 1, reason: 'completed' }),
    ]
    expect(findOpenStructures(frames).unpairedToolCalls).toEqual([])
  })

  it('只有 step 开着（轮也开着）→ 报 openStep 与 openTurn', () => {
    const frames = [ev('turn/start', 0, { turn: 2 }), ev('step/start', 1, { turn: 2, step: 3 })]
    expect(findOpenStructures(frames)).toMatchObject({
      openTurn: 2,
      openStep: { turn: 2, step: 3 },
    })
  })

  it('插件事件不参与闭合判定（06 §2.3 开放词汇表）', () => {
    const frames = [
      ev('turn/start', 0, { turn: 1 }),
      ev('compaction/start', 1, { compactionId: 'x' }),
      ev('myplugin/custom', 2, { foo: 1 }),
      ev('turn/end', 3, { turn: 1, reason: 'completed' }),
    ]
    expect(findOpenStructures(frames)).toMatchObject({
      openTurn: null,
      openStep: null,
      unpairedToolCalls: [],
    })
  })

  it('未闭合轮里的 approval/asked 必须识别为悬挂审批', () => {
    const frames = [ev('turn/start', 0, { turn: 1 }), ev('approval/asked', 1, { callId: 'approval-1' })]
    expect(findOpenStructures(frames).unpairedApprovals).toEqual([{ callId: 'approval-1' }])
  })
})

describe('T6.1 纯函数：合成收尾的顺序与内容', () => {
  const crashed = [
    ev('turn/start', 0, { turn: 1 }),
    ev('step/start', 1, { turn: 1, step: 1 }),
    ev('tool/call', 2, {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'read',
      arguments: '{}',
    }),
  ]

  it('顺序固定为 tool/result → step/end → turn/end → session/end-seed', () => {
    expect(synthesizeClosers(crashed, NOW).closers.map((c) => c.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(planRecovery(crashed, NOW).closers.map((c) => c.type)).toEqual(['tool/result', 'step/end', 'turn/end', 'session/end-seed'])
  })

  it('悬挂审批补 approval/decided(cancelled)，并排在 turn/end 之前', () => {
    const frames = [
      ev('turn/start', 1, { turn: 1 }),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('approval/asked', 3, { callId: 'approval-1' }),
    ]
    const result = planRecovery(frames, NOW)
    expect(result.closers.map((closer) => closer.type)).toEqual(['approval/decided', 'step/end', 'turn/end', 'session/end-seed'])
    expect(result.closers[0]).toMatchObject({
      data: {
        callId: 'approval-1',
        result: 'cancelled',
        decidedBy: 'cancelled',
      },
    })
  })

  it('未派发的工具结果是 isError + ABORTED_BEFORE_DISPATCH，并标记 repaired', () => {
    const closer = synthesizeClosers(crashed, NOW).closers[0]!
    expect(closer).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', toolCallId: 'c1', isError: true },
        error: { code: ABORTED_BEFORE_DISPATCH },
        meta: { repaired: true },
      },
    })
  })

  it('补记的 seq 是占位 -1（编号由调用方按保留后的事件数决定）', () => {
    expect(synthesizeClosers(crashed, NOW).closers.every((c) => c.seq === -1)).toBe(true)
    expect(planRecovery(crashed, NOW).closers.every((c) => c.seq === -1)).toBe(true)
  })

  it('补记紧贴崩溃时刻，不跳到恢复时刻（崩溃与恢复可能相隔很久）', () => {
    const crashedAt = 500_000
    const recoveredAt = 9_000_000_000_000
    const frames = [ev('turn/start', 0, { turn: 1 }, crashedAt)]
    // 锚点（最后一条事件的 time）由调用方传入，否则退到 now —— 这里显式传
    const times = synthesizeClosers(frames, recoveredAt, crashedAt).closers.map((c) => c.time)
    expect(Math.max(...times)).toBeLessThanOrEqual(crashedAt + MAX_REPAIR_GAP_MS)
  })

  it('planRecovery 幂等：对已补过的帧序列再跑，无补记也不写分界线', () => {
    const { frames } = appendClosers(crashed, planRecovery(crashed, NOW).closers, crashed.length)
    const again = planRecovery(frames, NOW)
    expect(again.closers).toEqual([])
    expect(again.repaired).toBe(false)
  })
})

describe('T6.1 纯函数：编号（I2 与 time 单调）', () => {
  it('seq 从 startSeq 起连续，且覆盖撕裂尾场景（startSeq ≠ frames.length）', () => {
    const kept = [
      ev('turn/start', 0, { turn: 1 }),
      ev('tool/call', 1, {
        turn: 1,
        step: 1,
        callId: 'c',
        name: 'read',
        arguments: '{}',
      }),
    ]
    const closers = planRecovery(kept, NOW).closers
    // 模拟"磁盘上有 4 条、但只有前 2 条可解析"：补记必须接在 2 之后
    const { appended } = appendClosers(kept, closers, 2)
    expect(appended.map((f) => f.seq)).toEqual([2, 3, 4])
  })

  it('time 单调不减：即便补记的 time 早于最后一条也不倒流', () => {
    const kept = [ev('turn/start', 0, { turn: 1 }, 9_000)]
    const closers = planRecovery(kept, 1_000).closers // 传入更早的 now
    const { appended } = appendClosers(kept, closers, 1)
    for (let i = 1; i < appended.length; i++) {
      expect(appended[i]!.time).toBeGreaterThanOrEqual(appended[i - 1]!.time)
    }
    expect(appended[0]!.time).toBeGreaterThanOrEqual(9_000)
  })

  it('无补记时返回原样副本，不产生任何帧', () => {
    const kept = [ev('turn/start', 0, { turn: 1 })]
    const { frames, appended } = appendClosers(kept, [], 1)
    expect(appended).toEqual([])
    expect(frames).toEqual(kept)
  })
})
