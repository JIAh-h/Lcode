# @lcode/sandbox-win32

> Windows 沙箱 Provider（AppContainer + 工作区 ACL + Job Object）。

## 状态

- [x] 原生 helper（`native/lcode_sandbox_win32.cpp`）：`--probe / --prepare / --run / --revoke / --verify-job`
- [x] 三档预设贯通：`read-only`（只读 ACL）/ `workspace-write`（读写工作区）/ `full-access`（仅 Job Object，不设文件/网络边界）
- [x] 网络：`--network allow` 时授予 `internetClient` capability，默认 deny
- [x] PTY：`wrapPty` 复用同一 helper（AppContainer 内启动 shell）
- [x] 真机验收：`LCODE_E2E_SANDBOX_WIN32=1 node scripts/smoke-sandbox-win32.mjs`（临时工作区授权后自动撤销）

## 构建

```bash
pnpm native:build-sandbox-win32
```

需要 Visual Studio C++ Build Tools；发布包携带预编译 helper（portable 复制到 `resources/app/native/`）。
