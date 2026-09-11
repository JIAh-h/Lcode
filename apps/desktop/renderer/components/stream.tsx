import { useState } from 'react'

/**
 * 会话流组件（文档 19 §3.2 P2 / UX-FOLD-001 / UX-SUMMARY-001 / UX-ARTIFACT-001）。
 * 结构：提问 + 过程流（可折叠，运行中自动展开、完成自动收起）+ 每轮总结卡（不可折叠）+ 产物入口。
 */

export function SessionStream() {
  const [phase, setPhase] = useState<'running' | 'done'>('done')
  return (
    <div className="stream">
      <UserBubble text="把 parse.ts 换成结构化解析" />
      {phase === 'running' ? <ProcessFlow collapsed={false} running /> : <ProcessFlow collapsed />}
      <SummaryCard
        done={phase === 'done'}
        seconds={86}
        onToggle={() => setPhase(phase === 'done' ? 'running' : 'done')}
      />
      <ArtifactEntry label="查看本轮所有产物/变更" />
    </div>
  )
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="msg user">
      <div className="bubble">{text}</div>
    </div>
  )
}

/** 过程流：思考与工具调用收在一个容器内；完成时整体收起为一行「过程记录」 */
export function ProcessFlow({ collapsed, running }: { collapsed: boolean; running?: boolean }) {
  const [open, setOpen] = useState(!collapsed)
  if (collapsed && !open) {
    return (
      <button className="process-closed" onClick={() => setOpen(true)}>
        <i className="st" style={{ background: 'var(--state-idle)' }} />
        过程记录 · 12 步 <span className="cnt">展开</span>
      </button>
    )
  }
  return (
    <div className={`process ${running ? 'running' : ''}`}>
      <button className="process-head" onClick={() => setOpen(!open)}>
        {running ? <span className="live">● 运行中</span> : '过程'}
        <span className="cnt">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <ol className="process-steps">
          <li>
            <span className="step-name">读取 src/parse.ts</span>
            <span className="step-state ok">完成</span>
          </li>
          <li>
            <span className="step-name">搜索所有调用点</span>
            <span className="step-state ok">完成</span>
          </li>
          <li>
            <span className="step-name">改写为结构化解析</span>
            <span className="step-state ok">完成</span>
          </li>
        </ol>
      )}
    </div>
  )
}

/** 总结卡：头部静态「✓ 任务完成 · 用时 N」；出现即覆盖前面全部折叠（UX-SUMMARY-001） */
export function SummaryCard({ done, seconds, onToggle }: { done: boolean; seconds: number; onToggle?: () => void }) {
  return (
    <div className="summary" onClick={onToggle}>
      <div className="summary-head">
        <span className="tick">{done ? '✓' : '…'}</span>
        <b>{done ? `任务完成 · 用时 ${seconds}s` : '正在完成…'}</b>
      </div>
      {done && (
        <div className="summary-body">
          <div>做了什么：把 parse.ts 从逐行正则替换为 schema 驱动的结构化解析</div>
          <div>验证：新增 6 个用例，全部通过</div>
          <div>需要你知道的：函数签名不变，导出名保持一致</div>
          <div className="summary-foot mono">2.4k tokens · Deepseek-V4.1</div>
        </div>
      )}
    </div>
  )
}

/** 产物入口：过滤右栏到本轮（UX-ARTIFACT-001） */
export function ArtifactEntry({ label }: { label: string }) {
  return (
    <button className="artifact">
      <span>📦</span> {label} <span className="cnt">6</span>
    </button>
  )
}
