/**
 * @lcode/shell-sandbox —— 骨架占位壳。
 * 受沙箱约束的 shell 实现
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
