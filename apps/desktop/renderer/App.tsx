import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell.tsx'
import { HomePage } from './pages/Home.tsx'
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
 */
export function App() {
  return (
    <AppShell>
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
    </AppShell>
  )
}
