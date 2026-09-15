import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { App } from './App.tsx'
import { syncLocaleFromMain } from './i18n/index.ts'
import './styles/app.css'

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
