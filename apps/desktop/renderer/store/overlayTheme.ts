/**
 * 主题变化时同步窗口控制按钮（最小化/最大化/关闭）的配色。
 *
 * `titleBarOverlay` 由 Windows 原生绘制，不吃 CSS 变量——应用切深色后按钮区
 * 还是浅色底，非常违和。所有主题切换入口（设置页外观 / 视图菜单）都应调用；
 * 主进程用 `setTitleBarOverlay` 同步，非 overlay 平台（Linux）静默忽略。
 */
export function syncWindowOverlayTheme(theme: 'light' | 'dark'): void {
  void window.lcode.setWindowOverlayTheme(theme).catch(() => {
    // 桥不可用（老版本 preload / 测试环境）：主题照常切换
  })
}
