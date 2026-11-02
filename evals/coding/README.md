# 编码评测集

面向真实模型的编码能力回归集。**不属于 CI**：它需要真实模型与 API Key，且成本/耗时不可预测。

## 它测什么

每个任务是一个独立的小仓库：

```
tasks/<id>/
  task.json      # id/title/prompt/test/agentTimeoutMs
  fixture/       # 初始仓库（模型只能看到这里）
  hidden/        # 隐藏测试；模型完成一轮后才复制进工作区
  solution/      # 参考解；只用于 --dry-run 验证题目本身
```

判分只看 **hidden 测试命令的退出码**。模型的自然语言、走了几步、改了哪些文件都不作为通过条件——允许多种合理路径，只断言最终状态。

## 用法

```bash
# 全部任务（真实模型；使用 ~/.lcode 的默认模型与凭据）
pnpm eval:coding

# 指定任务 / 模型
pnpm --filter @lcode/cli eval:coding --task fix-pagination --model provider/model

# 只验证题目与隐藏测试（不调用模型）
pnpm --filter @lcode/cli eval:coding --dry-run

# 保留临时工作区并写 JSON 报告
pnpm --filter @lcode/cli eval:coding --keep --out results/latest.json --verbose
```

也可以通过 CLI：

```bash
pnpm --filter @lcode/cli start eval --dry-run
```

## 隔离与安全

- 评测使用**临时 Lcode Home**：只复制 `settings.json`、`.env`、`credentials/` 并在临时库里重新登记凭据；
  真实 home 的权限预设、信任列表、会话记录不会被改动。
- 临时 home 的权限预设固定为「工作区内修改」；工作区是 `mkdtemp` 出来的 fixture 副本。
- 审批通道在评测中自动返回 `allowed-once`（非交互）。因此**不要把不受信任的 fixture 放进任务目录**：
  模型在评测工作区里执行的命令会被自动批准。
- `--keep` 会打印临时目录，便于回看会话日志与模型轨迹；默认跑完删除。

## 当前任务

| id | 考点 |
|---|---|
| `fix-pagination` | 1-based 分页边界（off-by-one） |
| `slugify-unicode` | 空白/标点归一与 Unicode 字母保留 |
| `retry-last-error` | 重试耗尽后抛最后一次错误、参数校验 |

2026-11-02 用本机默认模型跑过全部 3 个任务，全部通过（耗时 8s / 21s / 94s）。
供应商未返回 usage 时报告不显示 token 列。

## 增加任务

1. 新建 `tasks/<id>/task.json`，`prompt` 要写清可验证的行为与约束，不泄露 hidden 测试。
2. `fixture/` 放初始仓库；`hidden/` 放 `verify.mjs` 等测试文件；`solution/` 放参考解。
3. 先跑 `--dry-run`：它会把 `solution/` 覆盖进 fixture 再跑 hidden 测试。**dry-run 必须通过**，
   否则是题目/测试有问题，不是模型的问题。
4. 再跑真实模型；测试不要联网、不要依赖时间/随机数。
