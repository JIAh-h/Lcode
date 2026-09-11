# @lcode/credentials

> 能力层接口包（文档 18 / 20 §6.1「凭据与设置」族，`ctx.credentials`）。冻结模块（改接口走 ADR）。
> **凭据引用（credentialRef）**：指向"一个可解析的来源"的名字；**值本身永不出现**在 settings、日志、UI、导出中（I7）。

## 解析优先级（D22）

进程环境变量 > `Lcode Home/.env` > 项目 `.env` > OS keychain 记录；**每次操作重新解析**；
UI 必须显示"当前生效来源"（`doctor --model`）。

## 实现包

- `credentials-local`：env / .env / keychain

## Known Limitations

- 值只在 `prepareCall` 内部物化（20 §6.2：锁在同一注册代上）；本包只解析不缓存。
