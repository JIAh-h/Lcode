# @lcode/session-api

**内部方法契约的落地层**：把 [doc 21 §2.1](../../../docs/21-接口契约与错误码总表.md) 的 `sessions.*`（9 个方法）落成进程内服务。

## 为什么需要这个包（放哪一层的判据）

`sessions.*` 要把三样东西装到一起：`core/session`（日志 owner）+ JSONL（权威真相）+ SQLite（派生索引）。
但三处都不能放：

| 候选位置 | 为什么不行 |
|---|---|
| `core/session`（骨架层） | [20 §3.1](../../../docs/20-模块设计与接口清单.md) 硬性规定**骨架层不依赖实现包** |
| `session-persistence`（接口包） | [20 §2.3](../../../docs/20-模块设计与接口清单.md)：「接口包里出现实现代码是**架构错误**」 |
| `bundle/*`（集束） | [20 §7.3](../../../docs/20-模块设计与接口清单.md)：集束**只有装配声明**（`cordis.patch.yml`），没有逻辑代码 |

所以装配逻辑必须住在「能同时依赖接口包与实现包」的**边界层**——本包就是这一层。
（`settings.*` / `credentials.*` 不需要新包：它们各自的实现包 `settings-file` / `credentials-local` 本就是那个位置。）

## 命名

参数与返回字段**沿用 doc 21 的 snake_case**（`session_id` / `source_event_seqs` / `log_revision` …），
因为这些方法最终要经 IPC / JSON-RPC 暴露给插件与渲染层——在这里就对齐线格式，
上层只需透传，不必写一遍字段改名（改名点越多，漏改的机会越多）。
内部 TS 类型（`SessionEvent` / `Message`）仍是仓库通行的 camelCase。
