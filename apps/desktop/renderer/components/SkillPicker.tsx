import { useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'
import type { SkillEntry } from './ComposerBar.tsx'

/**
 * 技能二级浮层的内容：搜索、多选、管理入口。
 * 定位/点击外部由 PopMenu 的 flyout 负责，这里只渲染列表本身。
 */
export function SkillPicker({
  skills,
  selected,
  onToggle,
  onManage,
  onRefresh,
}: {
  readonly skills: readonly SkillEntry[]
  readonly selected: readonly string[]
  readonly onToggle: (id: string) => void
  readonly onManage: () => void
  readonly onRefresh: () => void
}) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    onRefresh()
  }, [])

  const needle = query.trim().toLowerCase()
  const filtered = skills.filter((skill) => (
    needle === '' ||
    skill.name.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  ))

  return (
    <div className="skillpicker">
      <input
        className="textinput skillpicker-search"
        placeholder={t('搜索技能')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="skillpicker-list">
        {filtered.map((skill) => {
          const checked = selected.includes(skill.id)
          return (
            <button
              type="button"
              className={'skillpick' + (checked ? ' on' : '')}
              key={skill.id}
              onClick={() => onToggle(skill.id)}
            >
              <span className="skillpick-mark">{checked ? '✓' : ''}</span>
              <span className="skillpick-main">
                <span className="skillpick-name">⚡ {skill.name}</span>
                <span className="skillpick-desc">{skill.description}</span>
              </span>
              <span className="skillpick-src">
                {skill.source === 'workspace' ? t('工作区') : skill.source === 'user' ? t('用户') : t('内置')}
              </span>
            </button>
          )
        })}
        {filtered.length === 0 ? (
          <div className="skillpicker-empty">
            {skills.length === 0 ? t('还没有技能。到「管理技能」导入 SKILL.md 或 zip。') : t('没有匹配的技能')}
          </div>
        ) : null}
      </div>
      <div className="skillpicker-foot">
        <span className="skillpicker-count">{t('已选 {n}', { n: selected.length })}</span>
        <button className="btn mini" onClick={onManage}>{t('管理技能')}</button>
      </div>
    </div>
  )
}
