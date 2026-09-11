import { ErrorBanner } from '../components/ui.tsx'

/** P8 异常（19 §3.8）：[发生了什么] + [一句原因] + [1–3 个可执行动作]。不显示堆栈。 */
export function ErrorPage() {
  return (
    <main className="page">
      <h2>出问题了</h2>
      <ErrorBanner
        userMessage="这个对话的记录损坏了，没法完整还原。可以试试导出已有的部分。"
        details="ES-CORRUPTED · 第 42 行记录不可解析（诊断信息，仅此可见）"
      />
      <div className="page-actions">
        <button className="btn">导出已有部分</button>
        <button className="btn primary">返回首页</button>
      </div>
    </main>
  )
}
