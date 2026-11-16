/**
 * 换肤插件的**渲染层**入口（docs/30 §9）。
 *
 * 这个文件跑在渲染进程（浏览器环境），**没有 Node 能力**：
 * 不能 require fs、不能起子进程。它能做的只有调用宿主给的 api。
 *
 * 导出 `render({ slot, api })`：返回 null 表示"不产出可见节点"，
 * 只做副作用（改 CSS 变量、设背景图）。
 */

/** 读取插件配置；宿主把它挂在 globalThis 上，插件不需要自己的存储。 */
function config() {
  const all = globalThis.__lcodePluginConfig
  return all && typeof all === 'object' ? all : {}
}

export function render({ api }) {
  const cfg = config()
  /*
   * 只改**设计令牌**，不改具体属性（比如直接写 background）。
   *
   * 令牌是宿主定义的一层间接：所有组件都读 `var(--bg-canvas)`，
   * 改令牌等于一次性换掉整套配色，而直接写 background 只能改到
   * 你手动列出来的那几个元素——那会得到"一半暗一半亮"的界面。
   */
  api.setCssVars({
    '--bg-canvas': cfg.canvas ?? '#14141c',
    '--bg-elevated': cfg.canvas ?? '#14141c',
    '--text-primary': cfg.text ?? '#e6e6ef',
    '--accent': cfg.accent ?? '#7c9cff',
  })

  // 没有可见节点，返回 null
  return null
}
