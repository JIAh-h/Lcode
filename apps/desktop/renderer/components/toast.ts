let timer: number | undefined

/**
 * 轻提示（与原型 #toast 行为一致：底部居中浮现，2.2s 后消失）。
 * 模块级单例，不依赖 React 状态树——菜单/设置/弹窗都能直接调用。
 */
export function toast(msg: string): void {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.add('show')
  window.clearTimeout(timer)
  timer = window.setTimeout(() => el?.classList.remove('show'), 2200)
}
