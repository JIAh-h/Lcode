import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from './components/AppShell.tsx'
import { ApprovalDialog } from './components/ApprovalDialog.tsx'
import { CloseConfirm } from './components/CloseConfirm.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { useLocale } from './i18n/index.ts'
import { HomePage } from './pages/Home.tsx'
import { syncModelsFromMain } from './store/modelSync.ts'
import { syncPermissionPresetFromMain } from './store/permissionSync.ts'
import { WorkspacePage } from './pages/Workspace.tsx'
import { ReplayPage } from './pages/Replay.tsx'
import { SettingsPage } from './pages/Settings.tsx'
import { RecoveryPage } from './pages/Recovery.tsx'
import { ForkPage } from './pages/Fork.tsx'
import { ErrorPage } from './pages/Error.tsx'
import { AskApprovalPage } from './pages/AskApproval.tsx'

/**
 * 路由配置（文档 19：P1–P8 八屏映射）。
 * 桌面外壳（AppShell：菜单栏 + 侧栏 + 底部设置入口）包裹所有路由。
 *
 * 错误边界放在 AppShell **内部**：页面崩了外壳还在，用户仍能切会话/回首页；
 * 换路由时按 pathname 自动复位，不会一直卡在崩溃态。
 */
export function App() {
  const { pathname } = useLocation()
  /* 界面语言：在此订阅一次即可——语言变化会重渲染整棵子树（本仓库无 memo），
     各组件直接调 `t()` 就能拿到最新文案，不必各自加 hook（见 renderer/i18n）。 */
  useLocale()
  /* 模型清单：全应用共用，所以在**根部**同步一次，不依赖任何页面。
     放在设置页里曾导致"启动后首页显示假模型、进过设置才对"（见 store/modelSync）。 */
  useEffect(() => {
    void syncModelsFromMain()
    void syncPermissionPresetFromMain()
  }, [])
  return (
    <AppShell>
      <ErrorBoundary resetKey={pathname}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/sessions/:sessionId" element={<WorkspacePage />} />
          <Route path="/sessions/:sessionId/replay" element={<ReplayPage />} />
          <Route path="/sessions/:sessionId/ask" element={<AskApprovalPage />} />
          <Route path="/sessions/:sessionId/recovery" element={<RecoveryPage />} />
          <Route path="/sessions/:sessionId/fork" element={<ForkPage />} />
          <Route path="/sessions/:sessionId/error" element={<ErrorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
      {/*
        审批弹窗挂在**根部**：它可能在任何一个页面上弹出来（模型随时可能决定
        改一个工作区外的文件）。挂在工作台里的话，用户在设置页时审批就没人问了
        —— 而"没人问"会走 fail-closed，表现为"操作莫名其妙被拒"。
      */}
      <ApprovalDialog />
      {/* 关闭确认同样挂根部：任何页面点关闭都要能拦住 */}
      <CloseConfirm />
    </AppShell>
  )
}
