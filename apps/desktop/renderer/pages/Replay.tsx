import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { t } from '../i18n/index.ts'

/**
 * P3 回放（文档 19 §3.3）：选中该步 → 看三快照（system / 工具 / 消息）。
 * 回到任意一步，看到当时**确切**的输入与输出（可解释优先于聪明）。
 *
 * 本页同时承载 **P7 的入口**：文档 19 §3.7 原本把「从这里重新开始」挂在
 * 时间轴脊柱上，该元素已于 2026-09-14 作废（[ADR-0106](../../../docs/17-架构决策记录ADR.md#adr-0106)），
 * 入口随之迁到本页——「选中一步 → 从这里重新开始」与原设计语义等价
 * （都是"从某个检查点分叉"，且旧会话完整保留）。
 */
export function ReplayPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const sid = sessionId ?? 'demo-1'

  return (
    <main className="page replay">
      <h2>{t('回放 · 第 {n} 步', { n: step })}</h2>
      <div className="replay-layout">
        <div className="replay-list">
          {[1, 2, 3, 4].map((s) => (
            <button key={s} className={`replay-item${s === step ? ' active' : ''}`} onClick={() => setStep(s)}>
              {t('第 {n} 步', { n: s })}
            </button>
          ))}
        </div>
        <div className="replay-snapshots">
          <section className="snap">
            <h4>{t('系统提示（当时的确切内容）')}</h4>
            <pre className="mono">{t('… 该步装配后的 system 快照 …')}</pre>
          </section>
          <section className="snap">
            <h4>{t('工具调用')}</h4>
            <pre className="mono">read src/parse.ts (1..80)</pre>
          </section>
          <section className="snap">
            <h4>{t('模型可见消息')}</h4>
            <pre className="mono">[user] 把 parse.ts 换成结构化解析</pre>
          </section>
        </div>
      </div>

      {/* P7 入口：从当前选中的这一步重新开始（旧会话保留） */}
      <div className="page-actions">
        <button className="btn primary" onClick={() => navigate(`/sessions/${sid}/fork`)}>
          {t('从第 {n} 步重新开始', { n: step })}
        </button>
      </div>
    </main>
  )
}
