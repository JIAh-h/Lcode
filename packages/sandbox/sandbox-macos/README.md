# @lcode/sandbox-macos

> macOS 沙箱 Provider：Seatbelt（`sandbox-exec` + 按回合生成 SBPL）。

## 状态

- [x] `createSeatbeltProfile`：文件（workspace / writableRoots 读写分离）、网络按 `allowNetwork`、`deny default` 白名单
- [x] read-only 档不生成 `file-write*` 规则
- [x] 三档预设：read-only / workspace-write 走 Seatbelt；完全访问不包装
- [x] PTY：`wrapPty` 复用 sandbox-exec 包装，交互终端不再裸启（Provider 不可用时按降级路径交给权限钩子）
- [x] 可选原生桥：`MacosSandboxBridge`（probe / wrap / wrapPty / releaseWorkspace）
- [ ] 真机验收：sandbox-exec 已废弃，需在目标 macOS 版本上验证 SBPL 语义与后续系统版本兼容性（当前开发机为 Windows）

## 后续

若 Apple 移除 `sandbox-exec`，替换为 EndpointSecurity / sandbox SPI 的 native bridge 即可；消费方不变。
