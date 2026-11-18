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

  /*
   * 背景媒体：图片或视频都走同一个接口，类型按扩展名推断。
   *
   * `lcode-plugin://<插件id>/<包内路径>` 是引用**插件自己目录**里素材的正确方式：
   * 宿主只伺服该插件目录、且只放行媒体类型（图片/视频/字体），
   * 所以不需要把几 MB 的视频塞进 data: URL。
   *
   * 非法地址会**抛错**（不是静默忽略），这里 catch 掉并退回到纯配色皮肤——
   * 让皮肤"少一个背景但仍可用"，而不是整个插件加载失败。
   */
  if (typeof cfg.background === 'string' && cfg.background !== '') {
    try {
      api.setBackgroundMedia({
        url: cfg.background,
        ...(typeof cfg.backgroundOpacity === 'number' ? { opacity: cfg.backgroundOpacity } : {}),
      })
    } catch (error) {
      console.warn('[theme-plugin] 背景媒体设置失败，已退回纯配色：', error)
    }
  } else {
    // 没配背景就明确清掉，避免切换配置后残留上一次的媒体
    api.setBackgroundMedia(null)
  }

  // 没有可见节点，返回 null
  return null
}
