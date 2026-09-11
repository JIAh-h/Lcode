/**
 * @lcode/plugin-host —— 骨架占位壳。
 * 插件宿主（独立 utility process，类型化 RPC）
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
