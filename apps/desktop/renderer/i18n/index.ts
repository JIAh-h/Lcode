import { useSyncExternalStore } from 'react'
import { EN } from './en-US.ts'

/**
 * 界面语言（i18n）。
 *
 * **取舍：中文原文即 key**，而不是语义化键名。
 * - 迁移成本最低：`t('常规')` 即可，不必为四百多条文案发明键名；
 * - 缺英文时自动回落中文原文，永远不会渲染出空串；
 * - 代价是同形异义无法区分，真遇到时把原文改写得更具体即可。
 *
 * **刷新机制**：语言是模块级状态，`t()` 调用时读当前值。顶层 `App` 用
 * `useLocale()` 订阅一次即可——React 默认重渲染整棵子树（本仓库无 `memo`），
 * 所以不必给每个组件加 hook，也不会因 remount 丢掉页面的局部状态。
 *
 * 文案纪律：本目录只放「用户可见文字」，不放日志、错误码、内部标识。
 */

export type Locale = 'zh-CN' | 'en-US'

/** 中文是源语言，zh-CN 词典留空（原文直接返回） */
const DICT: Record<Locale, Readonly<Record<string, string>>> = {
  'zh-CN': {},
  'en-US': EN,
}

/** 持久化键（浏览器存储，dev 下即生效；打包版另有主进程落盘兜底，见下） */
const STORAGE_KEY = 'lcode.locale'

/** 桌面桥（浏览器直开预览时不存在，所有调用都要容错） */
function bridge(): Window['lcode'] | undefined {
  return typeof window !== 'undefined' ? window.lcode : undefined
}

function readStored(): Locale {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'zh-CN' || v === 'en-US') return v
  } catch {
    // 打包后渲染进程走 file://，非标准 scheme 默认禁用 web storage，会抛错；
    // 此时靠 `syncLocaleFromMain()` 从主进程取回，不影响会话内使用。
  }
  return 'zh-CN'
}

let current: Locale = readStored()

/**
 * 启动时向主进程取回落盘的语言并应用。
 *
 * 之所以要有这条路径：打包后渲染进程是 `file://`，Electron 对非标准 scheme
 * 默认禁用 web storage，只靠 `localStorage` 会「重启又变回中文」。
 * 主进程写的是 `userData/locale.json`，稳定可靠。
 * 异步返回，最多造成一帧中文闪现，故放在首帧之后调用即可。
 */
export function syncLocaleFromMain(): void {
  const api = bridge()
  if (typeof api?.getLocale !== 'function') return
  void api.getLocale().then((saved) => {
    if (saved === 'zh-CN' || saved === 'en-US') setLocale(saved)
  })
}

/** `<html lang>` 与当前语言保持一致（无障碍 / 输入法行为） */
function syncHtmlLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
syncHtmlLang()

const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getLocale(): Locale {
  return current
}

/** 切换界面语言：立即生效 + 落盘（浏览器存储 + 主进程文件，双写） */
export function setLocale(next: Locale): void {
  if (current === next) return
  current = next
  syncHtmlLang()
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 见 readStored 的说明：file:// 下可能不可用，靠主进程兜底
  }
  const api = bridge()
  if (typeof api?.setLocale === 'function') void api.setLocale(next)
  emit()
}

/**
 * 翻译：`text` 传中文原文，`vars` 做 `{name}` 占位替换。
 * 例：`t('共 {n} 轮', { n: 2 })`
 */
export function t(text: string, vars?: Readonly<Record<string, string | number>>): string {
  let out = DICT[current][text] ?? text
  if (vars) {
    for (const key of Object.keys(vars)) {
      out = out.split('{' + key + '}').join(String(vars[key]))
    }
  }
  return out
}

/** 批量翻译：给 `options` 之类的字符串数组常量用，省去每个渲染点写 map */
export function tr(list: readonly string[]): string[] {
  return list.map((s) => t(s))
}

/**
 * 订阅语言变化。**只需在最顶层调用一次**（`App.tsx`）：
 * 组件树里任何地方调用 `t()` 都会拿到最新语言。
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}
