import { Link } from 'react-router-dom'

/** P7 重来（19 §3.7）：从某个检查点分叉——复制新会话，旧会话保留。 */
export function ForkPage() {
  return (
    <main className="page">
      <h2>从这里重来</h2>
      <p>将在「第 12 步 · 改写完成」处复制出一个新对话。原来的对话不会被改动。</p>
      <div className="fork-detail">
        <div>新对话：原始记录 + 你接下来的指令</div>
        <div>原对话：保留全部记录，可随时回来查看</div>
      </div>
      <Link to="/sessions/demo-1" className="btn primary">
        确认分叉
      </Link>
    </main>
  )
}
