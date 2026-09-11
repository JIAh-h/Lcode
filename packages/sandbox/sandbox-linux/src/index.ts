/**
 * @lcode/sandbox-linux —— 骨架占位壳。
 * Linux 沙箱（Landlock + seccomp）
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
