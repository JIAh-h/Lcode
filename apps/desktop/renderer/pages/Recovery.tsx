import { Link } from 'react-router-dom'
import { t } from '../i18n/index.ts'

/** P6 恢复（19 §3.6）：上次未正常退出，展示恢复摘要；补记节点在时间轴上**可区分**标注。 */
export function RecoveryPage() {
  return (
    <main className="page">
      <h2>{t('上次没有正常退出')}</h2>
      <p>{t('已经帮你恢复到最后一个完整的状态。恢复时补记了 2 条收尾记录，在时间轴上以补记样式标注。')}</p>
      <div className="recovery-summary">
        <div>{t('丢弃的撕裂记录：1 条（文件末尾不完整）')}</div>
        <div>{t('补记的合成事件：2 条（step/end + turn/end）')}</div>
      </div>
      <Link to="/sessions/demo-1" className="btn primary">
        {t('继续这个对话')}
      </Link>
    </main>
  )
}
