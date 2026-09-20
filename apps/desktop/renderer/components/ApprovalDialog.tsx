import { useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'

/**
 * 审批弹窗（12 §5.4；P4）。
 *
 * ## 这一块 UI 是 T1 的最后一道防线
 *
 * 前面所有层（沙箱、策略、守卫）都可能有洞，而**用户的眼睛是最后一道**。
 * 所以这里有一个硬要求：`impact.paths[].outsideWorkspace` 与
 * `impact.network.domains` **必须显著标出**（21 §6.2 的 `EP-OUTSIDE_WORKSPACE`
 * 要求"弹出询问框并显著标出工作区外"）。
 *
 * 把它们和普通路径一样灰扑扑地列出来 = 让用户以为那是一份普通文件列表，
 * 然后顺手点"允许"。那不是 UI 不够漂亮，那是防线失效。
 *
 * ## 一次性
 *
 * 没有"记住我的选择"（12 §5.1：内核没有这个状态位）。要"永久"就换个预设——
 * 那条路是有意识的、全局的，而"记住这个"是在用户没想清楚的时候替他做决定。
 */

interface ApprovalAction {
  readonly tool: string
  readonly summary: string
  readonly argv?: readonly string[] | undefined
  readonly cwd?: string | undefined
}

interface ApprovalBasis {
  readonly source: 'preset' | 'waterfall' | 'guard' | 'delegation'
  readonly reason: string
  readonly presetName?: string | undefined
}

interface ApprovalImpact {
  readonly paths?: readonly { path: string; mode: 'read' | 'write'; outsideWorkspace: boolean }[] | undefined
  readonly network?: { readonly domains: readonly string[] } | undefined
  readonly env?: readonly string[] | undefined
  readonly sandboxChange?: { readonly from: string; readonly to: string } | undefined
  readonly sandbox?: { readonly status: 'degraded'; readonly mechanism: string; readonly reason: string } | undefined
  readonly processScope?: string | undefined
}

export interface ApprovalRequest {
  readonly callId: string
  readonly action: ApprovalAction
  readonly basis: ApprovalBasis
  readonly impact: ApprovalImpact
}

interface ApprovalBridge {
  onAsked(handler: (payload: unknown) => void): () => void
  answer(input: { callId: string; result: 'allowed-once' | 'rejected' | 'cancelled' }): Promise<unknown>
  pending(): Promise<unknown>
}

function bridge(): ApprovalBridge | undefined {
  return (globalThis as unknown as { lcode?: { approval?: ApprovalBridge } }).lcode?.approval
}

export function ApprovalDialog() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const api = bridge()
    if (api === undefined) return
    // 内核那边在等这个回答；没订阅到就没人答 → fail-closed（12 §5.2）
    const stop = api.onAsked((payload) => setRequest(payload as ApprovalRequest))
    // Renderer 重载不会重启主进程；重新挂载后必须把仍在等待的完整问题拿回来。
    void api.pending().then((payload) => {
      const pending = Array.isArray(payload) ? payload[0] : undefined
      if (pending !== undefined) setRequest(pending as ApprovalRequest)
    }).catch(() => undefined)
    return stop
  }, [])

  if (request === null) return null

  const answer = (result: 'allowed-once' | 'rejected' | 'cancelled'): void => {
    if (busy) return
    setBusy(true)
    const api = bridge()
    void (api?.answer({ callId: request.callId, result }) ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        setBusy(false)
        setRequest(null)
      })
  }

  const outside = (request.impact.paths ?? []).filter((p) => p.outsideWorkspace)
  const inside = (request.impact.paths ?? []).filter((p) => !p.outsideWorkspace)
  const domains = request.impact.network?.domains ?? []

  return (
    <div className="modal-mask" role="dialog" aria-modal="true">
      <div className="modal approval">
        <h3>{t('确认这一步')}</h3>

        {/* ① 它要做什么（意图化摘要，不是 JSON dump） */}
        <div className="ap-action">{request.action.summary}</div>
        {request.action.argv !== undefined && (
          <div className="ap-argv mono">{request.action.argv.join(' ')}</div>
        )}

        {/* ② 为什么问你 */}
        <div className="ap-basis">
          {t('依据：')}
          {request.basis.presetName === undefined ? request.basis.reason : `${request.basis.presetName} · ${request.basis.reason}`}
        </div>

        {/* ③ 会碰到什么 —— 工作区外**必须**显著 */}
        {outside.length > 0 && (
          <div className="ap-danger">
            <div className="ap-danger-title">{t('它想改动这个项目之外的文件')}</div>
            {outside.map((p) => (
              <div className="ap-path mono" key={p.path}>
                {p.mode === 'write' ? '✎' : '👁'} {p.path}
              </div>
            ))}
            <div className="ap-danger-hint">{t('工作区外写入，需要你确认')}</div>
          </div>
        )}

        {domains.length > 0 && (
          <div className="ap-danger">
            <div className="ap-danger-title">{t('它要把数据发到这些站点')}</div>
            {domains.map((d) => (
              <div className="ap-path mono" key={d}>
                ⇢ {d}
              </div>
            ))}
          </div>
        )}

        {/* 工作区内的路径：不显著，但也不藏 —— 用户需要完整的画面 */}
        {inside.length > 0 && (
          <div className="ap-paths">
            {inside.map((p) => (
              <div className="ap-path mono" key={p.path}>
                {p.mode === 'write' ? '✎' : '👁'} {p.path}
              </div>
            ))}
          </div>
        )}

        {request.impact.env !== undefined && request.impact.env.length > 0 && (
          <div className="ap-meta">
            {t('会拿到这些环境变量：')}
            <span className="mono">{request.impact.env.join(', ')}</span>
          </div>
        )}

        {request.impact.sandboxChange !== undefined && (
          <div className="ap-meta">
            {t('沙箱将从 ')}<span className="mono">{request.impact.sandboxChange.from}</span>{t(' 变为 ')}<span className="mono">{request.impact.sandboxChange.to}</span>
          </div>
        )}

        {request.impact.sandbox !== undefined && (
          <div className="ap-danger">
            <div className="ap-danger-title">{t('当前操作没有系统级沙箱约束')}</div>
            <div className="ap-meta">{request.impact.sandbox.mechanism} · {request.impact.sandbox.reason}</div>
          </div>
        )}

        {request.impact.processScope !== undefined && (
          <div className="ap-meta">{t('进程范围：')}{request.impact.processScope}</div>
        )}

        {/* 故意**没有**"总是允许"：一次审批只管一次（12 §5.1） */}
        <div className="ap-foot">
          <button className="btn" disabled={busy} onClick={() => answer('rejected')}>
            {t('拒绝')}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => answer('allowed-once')}>
            {t('允许这一次')}
          </button>
        </div>
      </div>
    </div>
  )
}
