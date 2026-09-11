/**
 * @lcode/sandbox-macos —— 骨架占位壳。
 * macOS 沙箱（sandbox config，darwin only）
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
