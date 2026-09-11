# @lcode/scope

> 作用域原语（文档 20 §5.7）。`core/scope` 位于 `session` 与 `system-prompt` 的共同下游，
> 专门为避免循环依赖（00 §5.1：零循环依赖）。

## 职责

| 内容 | 说明 |
|---|---|
| `ScopeKey` | 不透明的注册作用域标识（`symbol \| string`）；Lcode 用活体 `Agent` 对象充当 |
| `Scoped<T>` | 按作用域取值：`get(scope): T \| undefined` |
| `ScopedLayers<L>` | 分层注册：`layer(scope, value): Disposer`，从最内层向外解析，命中即止 |

## 不变量

- 作用域必须可嵌套且查找顺序确定（从最内层向外解析，命中即止）。

## Known Limitations

- 不提供作用域生命周期管理（创建/销毁作用域是 `agent` 包的事）。
- 无 ctx key（纯库）。
