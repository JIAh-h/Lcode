import type { TodoItem } from '@lcode/session'
import { t } from '../i18n/index.ts'

/**
 * 输入框上方的本轮状态芯片：只承载**任务清单**（todo/write 快照）。
 *
 * 被编辑的文件**不在这里**显示——那是产物，渲染在回复末尾的
 * EditedFilesCard（docs/10，仿 DSH）。之前这里也聚合文件变更，
 * 用户反馈它一直在、且与产物卡片重复，已移除。
 */
export function TurnStatusBar({ todos }: { readonly todos: readonly TodoItem[] }) {
  const done = todos.filter((todo) => todo.status === 'done').length
  const active = todos.find((todo) => todo.status === 'in-progress')
  if (todos.length === 0) return null

  return (
    <div className="turnbar">
      <div className="turnchip">
        <button type="button" className="turnchip-head" aria-haspopup="true" title={t('任务清单')}>
          <span className="turnchip-icon" aria-hidden="true">☑</span>
          <span className="turnchip-count">{`${done}/${todos.length}`}</span>
          <span className="turnchip-label">{active === undefined ? t('任务清单') : active.text}</span>
        </button>
        <div className="turnchip-pop" role="tooltip">
          <div className="turnchip-pop-head">{t('任务清单')}</div>
          <div className="turnchip-list">
            {todos.map((todo) => (
              <div className={`turnchip-row turnchip-${todo.status}`} key={todo.id}>
                <span className="turnchip-mark">{todo.status === 'done' ? '✓' : todo.status === 'in-progress' ? '▸' : '○'}</span>
                <span className="turnchip-text">{todo.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
