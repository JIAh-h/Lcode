import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { t } from '../i18n/index.ts'

/**
 * 错误边界（公共页面组件）。
 *
 * 渲染进程此前没有任何兜底：任一页面抛错就整屏白掉。这里按 P8 异常页的
 * 同一套视觉与文案纪律处理——`[发生了什么] + [一句原因] + [可执行动作]`，
 * 堆栈收在默认收起的「详情」里（`UX-ERR-001`），界面不出现内部术语（`UX-COPY-001`）。
 *
 * 必须是 class 组件：React 的错误边界只有 `getDerivedStateFromError` /
 * `componentDidCatch` 两个生命周期，函数组件无法承担。
 */

interface Props {
  children: ReactNode
  /** 变化时自动复位（通常传路由 pathname）——否则跳转到别的页面仍是崩溃态 */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 骨架阶段没有遥测（文档 ADR-0105：遥测默认关闭），先落到控制台便于本地排查
    console.error('[Lcode] 界面渲染出错：', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <main className="page">
        <h2>{t('这个页面没能显示出来')}</h2>
        <div className="errbanner" role="alert">
          <span>{t('界面在渲染时出了点问题。你可以回到首页重新开始，或者重新加载一次。')}</span>
          <details className="errdetails">
            {error.message || String(error)}
            {error.stack ? `\n\n${error.stack}` : ''}
          </details>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            {t('重试')}
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            {t('重新加载')}
          </button>
          <button className="btn primary" onClick={() => window.location.assign('#/')}>
            {t('回到首页')}
          </button>
        </div>
      </main>
    )
  }
}
