import { Link, useParams } from 'react-router-dom'
import { t } from '../i18n/index.ts'

/**
 * P7 从某一步重新开始（文档 19 §3.7）。
 *
 * 文案纪律（§3.7 原文）：
 * - 用「重新开始」而不是「分叉」——后者是版本控制行话，用户不一定反应过来；
 * - **「不会带过去」这一行不能省**——用户最怕"我以为它都保留了"；
 * - 不自动前移切点（静默的语义偏移是信任的杀手），落在未关闭的轮内就明确报错。
 */
export function ForkPage() {
  const { sessionId } = useParams()
  const sid = sessionId ?? 'demo-1'

  return (
    <main className="page">
      <h2>{t('从第 12 步重新开始')}</h2>
      <div className="fork-detail">
        <div>
          <b>{t('从哪开始')}</b>：{t('第 12 步 · 改写完成')}
        </div>
        <div>
          <b>{t('会带过去')}</b>：{t('第 1–12 步的完整记录（当时模型看到的原样）')}
        </div>
        <div>
          <b>{t('不会带过去')}</b>：{t('第 13 步之后的全部内容，以及那之后对文件做的改动')}
        </div>
        <div>
          <b>{t('新对话的名字')}</b>：{t('把 parse.ts 换成结构化解析（副本）')}
        </div>
      </div>
      <p>{t('原来的对话不会被改动，可以随时回来查看。')}</p>
      <div className="page-actions">
        <Link to={`/sessions/${sid}`} className="btn">
          {t('取消')}
        </Link>
        <Link to={`/sessions/${sid}`} className="btn primary">
          {t('从这里重新开始')}
        </Link>
      </div>
    </main>
  )
}
