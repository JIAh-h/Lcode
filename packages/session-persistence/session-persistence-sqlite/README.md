# @lcode/session-persistence-sqlite

> 持久化实现包：**SQLite 索引 / 查询 / 会话元数据**（文档 22 §3，15 张表可执行 DDL）。
> SQLite 管"找到它"，JSONL 管"完整保存它"——两者职责不重叠（D12）。

## 表清单（22 §3）

| 表 | 作用 |
|---|---|
| `schema_version` | 连接前设与版本表（§3.0） |
| `sessions` | 会话元数据（§3.1） |
| `session_log_index` | 日志文件索引 + revision（§3.2） |
| `turns` / `steps` | 轮 / 步索引（§3.3） |
| `events` | 事件平面索引（§3.4） |
| `messages_projection` | 消息投影缓存（§3.5） |
| `tool_calls` | 工具调用索引（§3.6） |
| `file_changes` | 文件变更（§3.7） |
| `checkpoints` | 时间轴检查点（§3.8） |
| `settings_kv` / `settings_effective` | 设置键值 + 生效层（§3.9） |
| `credentials_refs` | 凭据引用（**值永不落库**，§3.10） |
| `plugins` | 插件元数据（§3.11） |
| `jobs` | 后台作业（§3.12） |
| `search_index`（FTS5） | 全文检索 + 触发器（§3.13） |

## 关键规则

- `sessions` 可随时由 JSONL 重建（22 §1.3）；`session_log_index.revision` 用于外部修改检测（`ES-LOG_MODIFIED_EXTERNALLY`）。
- `credentials_refs` 只存**引用名**（如 `DEEPSEEK_API_KEY`），值永不进入（I7 / 00 §2 第二条）。

## Known Limitations

- 骨架版提供 DDL 常量与连接初始化；查询实现随批次 ②/⑧ 落地。
- Windows 上 `ReplaceFile` 的退化路径（22 §4.3）在批次 ⑧ 实现。
