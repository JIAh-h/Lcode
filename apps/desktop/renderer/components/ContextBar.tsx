import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { t } from '../i18n/index.ts'
import { sessionBridge, workspaceInfoBridge, type GitStatusFile, type SessionContextUsage } from '../store/sessionBridge.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { PopMenu } from './PopMenu.tsx'
import { toast } from './toast.ts'

/**
 * 手动压缩的准入线：窗口占用必须超过 20%，否则视为上下文较短。
 * 摘要本身要花一次模型调用，刚压缩过或本来就没多少历史时压不出收益。
 * 自动压缩不经过这个按钮：回合内达到窗口 90% 时会在下一个步边界自行触发。
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
 * 右侧是上下文用量。点用量打开明细，可预览压缩、撤销上次压缩。
 *
 * 总量优先采用供应商返回的 usage；之后新增内容按本地估算补齐。窗口未配置时
 * 只显示 token 数，不拿一个假窗口算百分比。
 */
export function ContextBar({
  sessionId,
  workspace,
  branch,
  mode,
  isRepo,
  usage,
  running,
  openSignal = 0,
  onChanged,
  onGitChanged,
  onCompactRequest,
  onOpenSettings,
}: {
  readonly sessionId: string
  readonly workspace: string | null
  readonly branch: string | null
  readonly mode: 'local' | 'worktree'
  readonly isRepo: boolean
  readonly usage: SessionContextUsage | null
  /** 回合执行中：表面正在被写入，压缩切点不安全 */
  readonly running: boolean
  /** 递增时打开明细面板（供 /context 使用） */
  readonly openSignal?: number
  readonly onChanged: () => void
  /** 分支切换成功后刷新父级的 gitInfo / 工作区状态 */
  readonly onGitChanged?: (() => void) | undefined
  /** 打开压缩预览框（由父级渲染，输入区预警也能触发同一个入口） */
  readonly onCompactRequest: () => void
  readonly onOpenSettings: () => void
}) {
  /** 用量明细弹窗（纯展示，无动作） */
  const [usageOpen, setUsageOpen] = useState(false)
  /** 上下文占用弹窗（含压缩动作） */
  const [open, setOpen] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [branches, setBranches] = useState<readonly string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchBusy, setBranchBusy] = useState(false)
  const [confirmSwitch, setConfirmSwitch] = useState<{ readonly branch: string; readonly files: readonly GitStatusFile[]; readonly total: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // `/context` 打开的是**上下文占用**（含压缩入口），不是用量明细
    if (openSignal > 0) setOpen(true)
  }, [openSignal])

  /* 两个弹窗各自关闭：点外面或 Esc 时都收起来（不开的那次直接返回） */
  useEffect(() => {
    if (!usageOpen && !open) return
    const close = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setUsageOpen(false)
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setUsageOpen(false)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [usageOpen, open])

  useEffect(() => {
    setBranches([])
    setConfirmSwitch(null)
  }, [workspace])

  const loadBranches = (): void => {
    const api = workspaceInfoBridge()
    if (api === undefined || workspace === null || workspace === '' || !isRepo) return
    setBranchLoading(true)
    void api.gitBranches(workspace)
      .then((result) => setBranches(result.branches))
      .catch(() => undefined)
      .finally(() => setBranchLoading(false))
  }

  const switchBranch = async (target: string, allowDirty = false): Promise<void> => {
    if (target === branch) return
    if (running) {
      toast(t('任务进行中，不能切换分支'))
      return
    }
    const api = workspaceInfoBridge()
    if (api === undefined || workspace === null || workspace === '' || branchBusy) return
    setBranchBusy(true)
    try {
      const result = await api.gitSwitch({
        workspace,
        branch: target,
        ...(allowDirty ? { allowDirty: true } : {}),
      })
      if (!result.ok) {
        setConfirmSwitch({ branch: target, files: result.files, total: result.total })
        return
      }
      toast(t('已切换到分支 {branch}', { branch: target }))
      loadBranches()
      onGitChanged?.()
    } catch (error) {
      toast(error instanceof Error ? error.message : t('切换分支失败'))
    } finally {
      setBranchBusy(false)
    }
  }

  const branchItems = branchLoading
    ? [{ id: '__loading', label: t('正在读取分支…'), disabled: true }]
    : branches.length === 0
      ? [{ id: '__none', label: t('没有可切换的分支'), disabled: true }]
      : branches.map((name) => ({
          id: name,
          label: name,
          raw: true,
          checked: name === branch,
          disabled: running || branchBusy,
        }))

  const workspaceName = workspace === null || workspace === ''
    ? t('未设置工作区')
    : (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace)
  const percent = usage?.percent ?? null
  const used = usage?.usedTokens ?? 0
  const windowTokens = usage?.contextWindowTokens ?? null
  /*
   * 缓存命中率：**只在模型真的报告过时才算**。
   *
   * `cacheReported` 为假说明这个模型不回传 `cached_tokens`——此时显示 0% 是误导，
   * 会把"模型不支持"说成"我们没命中"。所以整块隐藏。
   */
  const inputTokens = usage?.measurement.observedInputTokens ?? 0
  const cachedTokens = usage?.measurement.cachedInputTokens ?? 0
  const outputTokens = usage?.measurement.observedOutputTokens ?? 0
  /** 会话累计 token（输入+输出）——弹窗顶部的"用了多少" */
  const totalTokens = inputTokens + outputTokens
  const cachePercent =
    usage?.measurement.cacheReported === true && inputTokens > 0
      ? Math.round((cachedTokens / inputTokens) * 100)
      : null
  const surface = usage?.measurement.surfaceTokens ?? 0
  const system = usage?.measurement.systemTokens ?? 0
  const tools = usage?.measurement.toolSchemaTokens ?? 0
  const imageTokens = usage?.measurement.imageTokens ?? 0
  const summaryTokens = usage?.measurement.summaryTokens ?? 0
  const contextTokens = usage?.provenance.contextTokens ?? 0
  const usageSource = usage?.usageSource ?? 'estimate'
  // 实测总量与估算构成按同一比例校准，保证各行相加等于「已用」
  const ratio = used > 0 && surface + system + tools > 0 ? used / (surface + system + tools) : 1
  const shownTools = Math.round(tools * ratio)
  const shownContext = Math.round(contextTokens * ratio)
  const shownImages = Math.round(imageTokens * ratio)
  const shownSummary = Math.round(summaryTokens * ratio)
  const shownSystem = Math.max(0, Math.round(system * ratio) - shownContext)
  const shownSurface = Math.max(0, used - shownSystem - shownTools - shownContext - shownImages - shownSummary)
  const tooShort = isContextTooShort(percent)
  const blocked = compactBlockedReason(false, running, tooShort)
  const sources = usage?.provenance.sources ?? []
  const skills = usage?.provenance.skills ?? []
  const images = usage?.provenance.images ?? 0
  const compaction = usage?.compaction ?? null

  const undo = (): void => {
    if (compaction === null || undoing) return
    const api = sessionBridge()
    if (api === undefined) return
    setUndoing(true)
    void api
      .compactUndo({ session_id: sessionId, compaction_id: compaction.compactionId })
      .then((result) => {
        if (result.status === 'undone') {
          toast(t('已撤销上次压缩，原文已恢复'))
          onChanged()
        } else {
          toast(t('这次压缩已无法撤销（摘要已被后续操作覆盖）'))
        }
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('撤销失败')))
      .finally(() => setUndoing(false))
  }

  return (
    <>
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
            {isRepo ? (
              <PopMenu
                buttonClass="cmbranchbtn"
                title={running ? t('任务进行中，不能切换分支') : t('切换 Git 分支')}
                width={240}
                up
                header={t('本地分支')}
                items={branchItems}
                onOpen={loadBranches}
                onSelect={(id) => {
                  if (id === '__loading' || id === '__none') return
                  void switchBranch(id)
                }}
                footer={running
                  ? t('任务进行中，暂时不能切换分支')
                  : t('切换不会丢弃未提交改动；冲突时 git 会拒绝。')}
                trigger={(
                  <>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                      <circle cx="11.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                      <circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M4.5 5v6M11.5 5v2.5a4 4 0 01-4 4H4.5" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                    {branch}
                    <span className="cmchev" aria-hidden="true">▾</span>
                  </>
                )}
              />
            ) : (
              <span className="cmbranch" title={t('当前 Git 分支')}>{branch}</span>
            )}
          </>
        ) : null}
      </div>
      <div className="cmright">
        {/*
         * 会话用量（docs/09 §3.2.3）：**纯展示**，不含任何动作。
         *
         * 与右侧「上下文占用」分开：那个弹窗里有「压缩上下文」这类**有副作用的动作**，
         * 而这里只是"这段会话花了多少、省了多少"。混在一起会让用户以为点这个就能压缩。
         */}
        <button
          type="button"
          className={'cmusage' + (usageOpen ? ' open' : '')}
          aria-expanded={usageOpen}
          title={t('查看用量明细')}
          onClick={() => setUsageOpen((value) => !value)}
        >
          {totalTokens > 0 && <span className="cmusage-tok">{t('{used} tok', { used: formatTokens(totalTokens) })}</span>}
          {cachePercent !== null && (
            <span className={`cmusage-cache${cachePercent >= 80 ? ' good' : cachePercent >= 40 ? '' : ' low'}`}>
              {t('缓存 {pct}', { pct: `${cachePercent}%` })}
            </span>
          )}
        </button>
        {usageOpen ? (
          <div className="cmpop cmpop-usage" role="dialog" aria-label={t('用量明细')}>
            <div className="cmpop-head">
              <span>{t('用量明细')}</span>
            </div>
            {/*
             * 缓存三项分开列：它们的**计价不同**（缓存读取只有原价的一小部分），
             * 合成一个数就看不出省了多少。
             */}
            <div className="cmpop-rows">
              <div className="cmrow cmrow-strong"><span>{t('累计输入')}</span><b>{formatTokens(inputTokens)}</b></div>
              <div className="cmrow"><span>{t('其中缓存读取')}</span><b>{cachePercent === null ? '—' : formatTokens(cachedTokens)}</b></div>
              <div className="cmrow"><span>{t('其中未缓存输入')}</span><b>{cachePercent === null ? '—' : formatTokens(Math.max(0, inputTokens - cachedTokens))}</b></div>
              <div className="cmrow"><span>{t('累计输出')}</span><b>{formatTokens(outputTokens)}</b></div>
              <div className="cmrow cmrow-strong">
                <span>{t('缓存命中率')}</span>
                <b>{cachePercent === null ? t('模型未报告') : `${cachePercent}%`}</b>
              </div>
            </div>
            <div className="cmpop-note">
              {cachePercent === null
                ? t('这个模型没有回报缓存用量，因此无法计算命中率。')
                : t('缓存命中的输入按供应商折扣计价；未命中部分按原价。')}
            </div>
          </div>
        ) : null}
        <button
          type="button"
          className={'cmusage' + (open ? ' open' : '') + (percent !== null && percent >= 80 ? ' warn' : '')}
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
                  {shownImages > 0 ? <div className="cmrow"><span>{t('图片')}</span><b>{formatTokens(shownImages)}</b></div> : null}
                  {shownSummary > 0 ? <div className="cmrow"><span>{t('压缩摘要')}</span><b>{formatTokens(shownSummary)}</b></div> : null}
                  <div className="cmrow"><span>{t('系统提示')}</span><b>{formatTokens(shownSystem)}</b></div>
                  {shownContext > 0 ? <div className="cmrow"><span>{t('运行时上下文')}</span><b>{formatTokens(shownContext)}</b></div> : null}
                  <div className="cmrow"><span>{t('工具描述')}</span><b>{formatTokens(shownTools)}</b></div>
                </div>
                {(sources.length > 0 || skills.length > 0 || images > 0 || usage?.provenance.summary === true) ? (
                  <div className="cmprov">
                    <div className="cmprov-title">{t('本轮来源')}</div>
                    <div className="cmprov-chips">
                      {skills.map((skill) => <span className="cmprov-chip skill" key={`skill-${skill.id}`}>⚡ {skill.name}</span>)}
                      {images > 0 ? <span className="cmprov-chip">{t('{n} 张图片', { n: images })}</span> : null}
                      {usage?.provenance.summary === true ? <span className="cmprov-chip">{t('包含压缩摘要')}</span> : null}
                      {sources.map((source) => <span className="cmprov-chip" key={source}>{source}</span>)}
                    </div>
                  </div>
                ) : null}
                {compaction !== null ? (
                  <div className="cmpop-last">
                    <span>{t('上次压缩：{before} → {after} 字符', { before: compaction.originalChars, after: compaction.summaryChars })}</span>
                    <button className="btn mini" disabled={undoing || running} onClick={undo}>
                      {undoing ? t('正在撤销…') : t('撤销压缩')}
                    </button>
                  </div>
                ) : null}
              </>
            )}
            <div className="cmpop-note">
              {usageSourceNote(usageSource)} {t('占用达到窗口 90% 时会在步边界自动压缩；手动压缩会先预览再提交。原始记录始终保留。')}
            </div>
            <div className="cmcompact-wrap">
              <button className="btn primary cmcompact" disabled={blocked !== null} onClick={onCompactRequest}>
                {t('压缩上下文')}
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
    {confirmSwitch !== null ? (
      <ConfirmDialog
        title={t('工作区有未提交改动')}
        message={t('还有 {n} 个未提交文件。切换分支会尝试保留这些改动；冲突时 git 会拒绝切换。', { n: confirmSwitch.total })}
        confirmLabel={t('仍然切换')}
        onCancel={() => setConfirmSwitch(null)}
        onConfirm={() => {
          const target = confirmSwitch
          setConfirmSwitch(null)
          void switchBranch(target.branch, true)
        }}
      />
    ) : null}
    </>
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
