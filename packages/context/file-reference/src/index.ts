/**
 * @lcode/file-reference —— 骨架占位壳。
 * 文件引用上下文
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
