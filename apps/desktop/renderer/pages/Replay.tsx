import { useState } from 'react'

/**
 * P3 回放（文档 19 §3.3）：选中该步 → 看三快照（system / 工具 / 消息）。
 * 回到任意一步，看到当时**确切**的输入与输出（可解释优先于聪明）。
 */
export function ReplayPage() {
  const [step, setStep] = useState(1)
  return (
    <main className="page replay">
      <h2>回放 · 第 {step} 步</h2>
      <div className="replay-layout">
        <div className="replay-list">
          {[1, 2, 3, 4].map((s) => (
            <button key={s} className={`replay-item${s === step ? ' active' : ''}`} onClick={() => setStep(s)}>
              第 {s} 步
            </button>
          ))}
        </div>
        <div className="replay-snapshots">
          <section className="snap">
            <h4>系统提示（当时的确切内容）</h4>
            <pre className="mono">… 该步装配后的 system 快照 …</pre>
          </section>
          <section className="snap">
            <h4>工具调用</h4>
            <pre className="mono">read src/parse.ts (1..80)</pre>
          </section>
          <section className="snap">
            <h4>模型可见消息</h4>
            <pre className="mono">[user] 把 parse.ts 换成结构化解析</pre>
          </section>
        </div>
      </div>
    </main>
  )
}
