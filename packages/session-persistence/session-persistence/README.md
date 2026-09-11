# @lcode/session-persistence

> 能力层接口包（文档 22，`ctx.sessionPersistence`）：**会话持久化的契约**。
> 冻结模块（改接口走 ADR）。

## 职责边界（D12）

| 层 | 管什么 | 不管什么 |
|---|---|---|
| **JSONL**（权威归档） | 完整保存每一个事件（追加式、可重建） | 查询 / 索引 |
| **SQLite**（索引/查询/会话元数据） | 找到它（列表、搜索、元数据） | 完整性保证（可随时由 JSONL 重建） |

两者职责不重叠：**JSONL 是权威，SQLite 可重建**（22 §1）。

## 实现包

- `session-persistence-jsonl`：帧编解码 + chunk 批打包（22 §4）
- `session-persistence-sqlite`：15 张表 DDL + 索引写入/读取（22 §3）

## Known Limitations

- 崩溃恢复契约（撕裂尾 / revision 变更检测 / `ES-RECOVERY_REPAIRED`）在批次 ⑧ 落地，接口已预留。
