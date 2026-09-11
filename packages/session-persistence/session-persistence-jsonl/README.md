# @lcode/session-persistence-jsonl

> 持久化实现包：**JSONL 事件日志的物理编码**（文档 22 §4，权威归档层）。

## 编码规则（22 §4.1）

- 一会话一文件、一行一帧（ndjson）；第 0 帧是**头部帧**，其后全是**事件**记录
- `seq` 必须连续；`load()` 必须还原出完全相同的追加序列
- 工具参数存**原始 JSON 字符串**，不存解析后对象（D9）

## 连续 chunk 打包（22 §4.2）

`assistant/chunk` 可达全部事件的 60–80%；对同一 `(turn, step)` 的极大连续 chunk 段打包为
一条 `assistant/chunk/batch` 记录，压缩比约 45%–65%，**不丢任何信息**，只换物理排布。
还原是纯函数：`seq = seqFirst + i`，`time = 批首 time + dt[i]`。

- 只打包**极大连续段**（遇任何非 chunk 事件即封口）；段长上限 4096 条
- `dt` 为相对批首的整数毫秒差（同毫秒为 0）
- 被打包的 chunk 不携带 `surfaceOp`；解包后逐条 `seq` 重新连续（I2 在解包后校验）

## 撕裂与损坏（22 §4.4）

- **最后一条**不可解析 → 撕裂，**丢弃**
- **非最后一条**不可解析 → `ES-CORRUPTED`，报错不猜
- `formatVersion` 未知 → `ES-FORMAT_UNSUPPORTED`，绝不尽力解析

## Known Limitations

- 骨架版提供编解码纯函数；文件 I/O 与目录布局（22 §2）、原子物化 / revision（22 §4.3）随批次 ②/⑧ 落地。
