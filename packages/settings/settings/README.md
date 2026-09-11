# @lcode/settings

> 能力层接口包（文档 18 / 20 §6.1「凭据与设置」族，`ctx.settings`）。冻结模块（改接口走 ADR）。
> **六层配置模型（D19）**：单次覆盖 > 会话选择 > 工作区预设 > 用户设置 > 适配器基座 > schema 默认。
> **逐字段合并，不整块替换**。配置里只放**引用**（凭据值永不进入，I7）。

## 实现包

- `settings-file`：落盘 `settings.json`（Lcode Home，22 §2）

## Known Limitations

- 六层合并解析的完整实现随批次 ④（llm-deepseek + settings + credentials 联动）落地。
