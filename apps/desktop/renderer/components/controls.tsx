import { useState } from 'react'
import type { ClipboardEventHandler, KeyboardEventHandler, Ref } from 'react'
import { t } from '../i18n/index.ts'
import { PopMenu } from './PopMenu.tsx'

/**
 * 通用表单控件（公共组件）。
 *
 * 设置页原先自带一套 `Switch` / `SwRow` / `Seg` / `Chips`，其余页面没有；
 * 下拉则直接用原生 `<select>`——弹层是操作系统画的，与 `PopMenu` 的自绘弹层
 * 视觉不统一。这里把通用控件收敛到一处，所有页面共用同一套。
 *
 * 样式仍复用既有类名（`.switch` / `.seg` / `.tokchips` / `.field` / `.mmfield`），
 * 因此视觉与改造前一致，只是**行为与实现**统一了。
 */

/** 开关（受控） */
export function Switch({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button className={'switch' + (on ? ' on' : '')} title={title} role="switch" aria-checked={on} onClick={onToggle} />
  )
}

/**
 * 设置行：左侧标签 + 右侧开关与说明（自持状态）。
 * 标签与说明在此处统一过 `t()`——调用方传中文原文即可，不必各自包一层。
 */
export function SwitchRow({ label, desc, init = false }: { label: string; desc: string; init?: boolean }) {
  const [on, setOn] = useState(init)
  return (
    <div className="srow">
      <div className="sl">{t(label)}</div>
      <div className="sr">
        <div className="swrow">
          <Switch on={on} onToggle={() => setOn(!on)} />
          <span className="swd">{t(desc)}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 分段控件：少量互斥选项、全部可见。
 * `options` 传中文原文，**内部只翻译展示文案，`value` 与回调始终是原文**
 * ——这样调用方的状态语义不受语言影响（切语言不会改变"当前选中哪一项"）。
 */
export function Seg({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly string[]
  value: string
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <div className={'seg' + (className ? ` ${className}` : '')} role="group">
      {options.map((o) => (
        <button key={o} className={o === value ? 'on' : ''} aria-pressed={o === value} onClick={() => onChange(o)}>
          {t(o)}
        </button>
      ))}
    </div>
  )
}

/** 胶囊单选组：选项较多、允许留空（空值显示为「默认」） */
export function ChipGroup({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label?: string
  hint?: string
  options: readonly string[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="chipfield">
      {label ? (
        <span className="mmlab">
          {t(label)}
          {hint ? <em>{t(hint)}</em> : null}
        </span>
      ) : null}
      <div className="tokchips">
        {options.map((o) => (
          <button
            key={o || 'default'}
            type="button"
            className={value === o ? 'on' : ''}
            aria-pressed={value === o}
            onClick={() => onChange(o === '' || value === o ? '' : o)}
          >
            {o === '' ? t('默认') : t(o)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 下拉选择：自绘弹层，与首页「选择项目」、composer 的「权限 / 模型」同一套视觉。
 * 不要用原生 `<select>`——它的弹层由操作系统绘制，无法与自绘下拉保持一致。
 * 与 `Seg` 同理：`options` 传中文原文，仅展示文案翻译。
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = '请选择',
  up = false,
}: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  placeholder?: string
  up?: boolean
}) {
  return (
    <PopMenu
      block
      up={up}
      buttonClass="selectbtn"
      trigger={
        <>
          <span className="selval">{value ? t(value) : t(placeholder)}</span>
          <i className="chev">▾</i>
        </>
      }
      items={options.map((o) => ({ id: o, label: t(o), checked: o === value }))}
      onSelect={onChange}
    />
  )
}

/** 单行文本输入 */
export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  inputRef,
  onEnter,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string | undefined
  type?: 'text' | 'password'
  autoComplete?: string | undefined
  inputRef?: Ref<HTMLInputElement> | undefined
  onEnter?: (() => void) | undefined
  /** 追加类名（如设置页搜索框的 `.setsearch`），用于复用既有样式 */
  className?: string | undefined
}) {
  return (
    <input
      className={'textinput' + (className ? ` ${className}` : '')}
      type={type}
      value={value}
      placeholder={placeholder}
      autoComplete={autoComplete}
      ref={inputRef}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={
        onEnter
          ? (e) => {
              if (e.key === 'Enter') onEnter()
            }
          : undefined
      }
    />
  )
}

/** 多行文本（受控传 value/onChange，非受控传 defaultValue）
 *
 * `variant`：
 * - `field`（默认）表单里的输入框外观（`.field .textarea`）
 * - `bare` 无边框、由外层容器负责外观——composer 用它（外层 `.cin` 已带边框）
 */
export function TextArea({
  value,
  onChange,
  defaultValue,
  placeholder,
  rows,
  variant = 'field',
  onKeyDown,
  onPaste,
}: {
  value?: string | undefined
  onChange?: ((v: string) => void) | undefined
  defaultValue?: string | undefined
  placeholder?: string | undefined
  rows?: number | undefined
  variant?: 'field' | 'bare'
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement> | undefined
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined
}) {
  return (
    <textarea
      className={variant === 'field' ? 'textarea' : undefined}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      rows={rows}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    />
  )
}
