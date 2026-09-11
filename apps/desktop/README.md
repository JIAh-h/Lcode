# @lcode/desktop

> 桌面应用（文档 10 / 20 §7.1）：Electron **main / preload / renderer** 三进程骨架。

## 进程职责（20 §7.1 硬性）

| 进程 | 职责 | 硬性 |
|---|---|---|
| main | 承载 agent runtime（spawn / PTY / fs）；持状态；不渲染 | 渲染崩溃不影响会话（状态在 main） |
| renderer | 纯投影：消费 `session/event`（数据）与 `agent/*`（控制状态） | **不直接访问 fs / 不直接发模型请求** |
| utility | 插件宿主（每插件一个，类型化 RPC） | 可整体杀掉；崩溃可重启（骨架未启用） |
| preload | `contextBridge` 白名单 API | 只暴露明确的方法，不暴露 `ipcRenderer` |

## 路由（8 屏 ↔ 19 号文档 P1–P8）

| 路由 | 页面 | 规格 |
|---|---|---|
| `/` | 首页 | 19 §3.1 P1 |
| `/sessions/:sessionId` | 工作台 | 19 §3.2 P2（**签名元素：常驻时间轴脊柱**） |
| `/sessions/:sessionId/replay` | 回放 | 19 §3.3 P3 |
| `/sessions/:sessionId/ask` | 询问弹窗 | 19 §3.4 P4 |
| `/settings` | 设置 | 19 §3.5 P5 |
| `/sessions/:sessionId/recovery` | 恢复 | 19 §3.6 P6 |
| `/sessions/:sessionId/fork` | 重来（分叉） | 19 §3.7 P7 |
| `/sessions/:sessionId/error` | 异常 | 19 §3.8 P8 |

## 设计令牌

`renderer/styles/theme.css` 严格取自原型 CSS 变量（浅 / 深 / 色盲友好三态），
校验脚本（check:docs）保证规格外色值 = 0。

## 界面术语黑名单

`UX-COPY-001`（19 §6.2）：界面不出现内部术语（事件名 / 字段名 / 错误码 / 机制名）。
新增文案必须自查。

## Known Limitations

- 骨架版 renderer 为**纯静态 UI**（无真实事件流驱动）；`store/` 提供事件投影的 reducer 结构，
  数据接入随批次 ⑦/⑧（main ↔ renderer 的 IPC 事件流）。
- `tsconfig.client.json` 不含 `node:*` 类型：渲染进程禁止导入 Node 模块（编译期防线）。
