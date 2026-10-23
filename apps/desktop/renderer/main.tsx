import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { App } from './App.tsx'
import { syncLocaleFromMain } from './i18n/index.ts'
import './styles/app.css'

/**
 * 滚动条只在滚动过程中出现：滚动时给元素加 `.is-scrolling`，停止 700ms 后移除。
 * CSS 的 `:hover` 会把“鼠标停在会话区”误当成需要显示滚动条，和产品要求不符。
 */
function installAutoHideScrollbars(): void {
  const timers = new WeakMap<Element, number>()
  const reveal = (element: Element): void => {
    element.classList.add('is-scrolling')
    const previous = timers.get(element)
    if (previous !== undefined) window.clearTimeout(previous)
    const timer = window.setTimeout(() => {
      element.classList.remove('is-scrolling')
      timers.delete(element)
    }, 700)
    timers.set(element, timer)
  }
  document.addEventListener(
    'scroll',
    (event) => {
      const target = event.target
      reveal(target instanceof Element ? target : document.documentElement)
    },
    { capture: true, passive: true },
  )
}

installAutoHideScrollbars()

/**
 * Chromium 默认会把拖入的文件当成导航目标，松手后整窗跳到 file://。
 * 应用里的拖放都有明确用途（选项目 / 加附件），没命中放置区时也应安静地无效。
 */
function installDropGuard(): void {
  const prevent = (event: DragEvent): void => event.preventDefault()
  window.addEventListener('dragover', prevent)
  window.addEventListener('drop', prevent)
}

installDropGuard()

// Hash 路由：Electron file:// 环境下也能工作（文档 19：8 屏映射）
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)

// 首帧之后再取主进程落盘的语言（异步，避免阻塞启动；见 i18n/index.ts 的说明）
syncLocaleFromMain()
