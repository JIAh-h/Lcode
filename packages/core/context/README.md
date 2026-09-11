# @lcode/context

> 内核层（文档 05 §L1）：**Context / Service / Event / Effect**。
> 插件框架的最小实现——服务查找、事件派发（四种模式）、可逆副作用注册。

## 职责

| 概念 | 说明（文档 00 §6 术语表） |
|---|---|
| **服务** service | 通过 `ctx.<key>` 被查找的能力提供者。接口包通过声明合并把 key 注册进 `Services` |
| **事件** event | 命名的可订阅通知；四种派发模式（`emit` / `waterfall` / `parallel` / `serial`） |
| **副作用** effect | 可逆的注册操作；注册即返回撤销器（disposer） |
| **作用域** scope | 服务与事件的注册归属；查找从最内层向外（委托 `@lcode/scope`） |

## 事件派发模式（D7：模式属于事件的公开契约）

| 模式 | 语义 | 签名 |
|---|---|---|
| `emit` | 广播：顺序 await 全部 handler，互不短路 | `on(name, h)` / `emit(name, payload)` |
| `waterfall` | 洋葱中间件：`(args, next) => Result`；调用 `next()` 委托，直接返回则短路 | `waterfall(name, args, ctx)` |
| `parallel` | 并发执行全部 handler | `emitParallel` |
| `serial` | 顺序执行，前一结果可作为后一输入 | `emitSerial` |

## 声明合并（接口包的标准写法，文档 20 §4.2）

```ts
declare module '@lcode/context' {
  interface Services {
    fs: FsService
  }
  interface Events {
    'fs/changed': { path: string; kind: 'create' | 'update' | 'delete' }
  }
}
```

## Known Limitations

- 进程内实现（plugin-host 出现前的过渡）；插件进程隔离见 `extension/*`（批次外）。
- `waterfall` 结果类型当前固定为 `unknown`，模式契约的精确泛型随 07 号文档定稿收紧。
