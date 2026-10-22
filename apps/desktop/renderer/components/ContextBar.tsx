import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { t } from '../i18n/index.ts'
import type { SessionContextUsage } from '../store/sessionBridge.ts'

/**
 * 手动压缩的准入线：窗口占用必须超过 20%，否则视为上下文较短。
 * 摘要本身要花一次模型调用，刚压缩过或本来就没多少历史时压不出收益。
 * 压缩只由用户显式触发，没有任何自动触发路径。
 */
const MIN_COMPACT_PERCENT = 20

export function isContextTooShort(percent: number | null): boolean {
  return percent !== null && percent <= MIN_COMPACT_PERCENT
}

export type CompactBlock = 'running' | 'short' | null

/** 运行中优先于「较短」；正在压缩时只显示进度，不再叠加别的提示 */
export function compactBlockedReason(compacting: boolean, running: boolean, tooShort: boolean): CompactBlock {
  if (compacting) return null
  if (running) return 'running'
  return tooShort ? 'short' : null
}

/**
 * 输入框下方的状态行（Qoder 同位置）：左侧是「工作区 · 本地/worktree · 分支」，
 * 右侧是上下文用量。点用量打开明细，并可手动压缩。
 *
 * 总量优先采用供应商返回的 usage；之后新增内容按本地估算补齐。窗口未配置时
 * 只显示 token 数，不拿一个假窗口算百分比。
 */
export function ContextBar({
  workspace,
  branch,
  mode,
  usage,
  compacting,
  running,
  onCompact,
  onOpenSettings,
}: {
  readonly workspace: string | null
  readonly branch: string | null
  readonly mode: 'local' | 'worktree'
  readonly usage: SessionContextUsage | null
  readonly compacting: boolean
  /** 回合执行中：表面正在被写入，压缩切点不安全 */
  readonly running: boolean
  readonly onCompact: () => void
  readonly onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const workspaceName = workspace === null || workspace === ''
    ? t('未设置工作区')
    : (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace)
  const percent = usage?.percent ?? null
  const used = usage?.usedTokens ?? 0
  const windowTokens = usage?.contextWindowTokens ?? null
  const surface = usage?.measurement.surfaceTokens ?? 0
  const system = usage?.measurement.systemTokens ?? 0
  const tools = usage?.measurement.toolSchemaTokens ?? 0
  const usageSource = usage?.usageSource ?? 'estimate'
  // 实测总量与估算构成按同一比例校准，保证三行相加等于「已用」
  const ratio = used > 0 && surface + system + tools > 0 ? used / (surface + system + tools) : 1
  const shownSystem = Math.round(system * ratio)
  const shownTools = Math.round(tools * ratio)
  const shownSurface = Math.max(0, used - shownSystem - shownTools)
  const tooShort = isContextTooShort(percent)
  const blocked = compactBlockedReason(compacting, running, tooShort)

  return (
    <div className="cinmeta" ref={rootRef}>
      <div className="cmleft">
        <span className="cmws" title={workspace ?? undefined}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          {workspaceName}
        </span>
        <span className="cmsep">·</span>
        <span className="cmmode" title={t(mode === 'worktree' ? '独立的 Git worktree' : '直接在当前目录工作')}>
          {mode === 'worktree' ? 'worktree' : t('本地')}
        </span>
        {branch !== null && branch !== '' ? (
          <>
            <span className="cmsep">·</span>
            <span className="cmbranch" title={t('当前 Git 分支')}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="11.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4.5 5v6M11.5 5v2.5a4 4 0 01-4 4H4.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              {branch}
            </span>
          </>
        ) : null}
      </div>
      <div className="cmright">
        <button
          type="button"
          className={'cmusage' + (percent !== null && percent >= 80 ? ' warn' : '')}
          aria-expanded={open}
          title={t('查看上下文占用')}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="cmring" style={{ '--pct': percent ?? 0 } as CSSProperties} />
          {percent === null ? t('未配置窗口') : `${percent}%`}
        </button>
        {open ? (
          <div className="cmpop" role="dialog" aria-label={t('上下文窗口')}>
            <div className="cmpop-head">
              <span>{t('上下文窗口')}</span>
              <span className="cmpop-pct">{percent === null ? '—' : `${percent}%`}</span>
            </div>
            {windowTokens === null ? (
              <div className="cmpop-hint">
                {t('还没有可用的上下文窗口（可能尚未选择模型）。到「设置 → 模型」选择模型后，这里会显示占用比例。')}
                <button className="btn mini" onClick={onOpenSettings}>{t('去设置')}</button>
              </div>
            ) : (
              <>
                <div className="cmpop-sub">
                  <span>{t('已用 {used} / {total} tokens', { used: formatTokens(used), total: formatTokens(windowTokens) })}</span>
                  <span className={`cmpop-src ${usageSource}`}>{usageSourceLabel(usageSource)}</span>
                </div>
                <div className="cmbar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, percent ?? 0)}%` }} className={percent !== null && percent >= 80 ? 'warn' : ''} />
                </div>
                <div className="cmpop-rows">
                  <div className="cmrow"><span>{t('对话')}</span><b>{formatTokens(shownSurface)}</b></div>
                  <div className="cmrow"><span>{t('系统提示')}</span><b>{formatTokens(shownSystem)}</b></div>
                  <div className="cmrow"><span>{t('工具描述')}</span><b>{formatTokens(shownTools)}</b></div>
                </div>
              </>
            )}
            <div className="cmpop-note">
              {usageSourceNote(usageSource)} {t('压缩会摘要较早历史并消耗一次模型调用，原始记录仍保留。')}
            </div>
            <div className="cmcompact-wrap">
              <button className="btn primary cmcompact" disabled={compacting || blocked !== null} onClick={onCompact}>
                {compacting ? t('正在压缩…') : t('压缩上下文')}
              </button>
              {blocked !== null ? (
                <span className="cmpop-tip" role="tooltip">
                  {blocked === 'running' ? t('任务进行中，暂时无法压缩') : t('当前上下文较短，无需压缩')}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function usageSourceLabel(source: SessionContextUsage['usageSource']): string {
  if (source === 'provider') return t('实测')
  if (source === 'mixed') return t('实测+估算')
  return t('估算')
}

function usageSourceNote(source: SessionContextUsage['usageSource']): string {
  if (source === 'provider') return t('总量来自最近一次请求的供应商 usage，明细为估算校准。')
  if (source === 'mixed') return t('总量 = 最近一次供应商 usage + 之后新增内容的估算，明细为估算校准。')
  return t('供应商尚未返回 usage，当前为本地估算。')
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}
