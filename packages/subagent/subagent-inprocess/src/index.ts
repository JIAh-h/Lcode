/**
 * @lcode/subagent-inprocess —— 骨架占位壳。
 * 子代理进程内实现（能力只可收窄）
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
