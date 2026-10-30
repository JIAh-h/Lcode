import { useMemo } from 'react'
import type { TodoItem } from '@lcode/session'
import { t } from '../i18n/index.ts'
import { aggregateTurnChanges, type TurnChange } from '../utils/turn-changes.ts'

export type { TurnChange } from '../utils/turn-changes.ts'

/**
 * 输入框上方的本轮状态芯片（仿 Qoder）：默认只占一行，悬停才浮出列表。
 * 左边是任务清单（todo/write 快照），右边是本轮会话改过的文件（diff 卡片投影）。
 */
export function TurnStatusBar({ todos, changes }: { readonly todos: readonly TodoItem[]; readonly changes: readonly TurnChange[] }) {
  const { files, additions, deletions } = useMemo(() => aggregateTurnChanges(changes), [changes])
  const done = todos.filter((todo) => todo.status === 'done').length
  const active = todos.find((todo) => todo.status === 'in-progress')
  if (files.length === 0 && todos.length === 0) return null

  return (
    <div className="turnbar">
      {todos.length > 0 ? (
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
      ) : null}
      {files.length > 0 ? (
        <div className="turnchip">
          <button type="button" className="turnchip-head" aria-haspopup="true" title={t('本轮修改的文件')}>
            <span className="turnchip-label">{t('{n} 个文件已修改', { n: files.length })}</span>
            <span className="turnchip-top add">+{additions}</span>
            <span className="turnchip-top del">-{deletions}</span>
          </button>
          <div className="turnchip-pop" role="tooltip">
            <div className="turnchip-pop-head">
              {t('{n} 个文件已修改', { n: files.length })}
              <span className="turnchip-top add">+{additions}</span>
              <span className="turnchip-top del">-{deletions}</span>
            </div>
            <div className="turnchip-list">
              {files.map((file) => (
                <div className="turnchip-row" key={file.path}>
                  <span className="turnchip-path mono" title={file.path}>{file.path}</span>
                  <span className="turnchip-nums">
                    <span className="add">+{file.additions}</span> <span className="del">-{file.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
