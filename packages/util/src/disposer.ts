/**
 * Disposer —— 撤销器（文档 00 §6 术语表）。
 * 可逆副作用的注册操作返回撤销器；卸载插件时被调用（文档 07：卸载即回滚）。
 */

export type Disposer = () => void

export const noopDisposer: Disposer = () => {}

/**
 * 组合多个撤销器：按**逆序**回滚（后注册的先撤销，文档 21 EX：撤销器逆序回滚）。
 */
export function composeDisposers(...disposers: Array<Disposer | undefined>): Disposer {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (let i = disposers.length - 1; i >= 0; i--) {
      disposers[i]?.()
    }
  }
}

/** 只执行一次的撤销器包装（幂等） */
export function once(fn: Disposer): Disposer {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}
