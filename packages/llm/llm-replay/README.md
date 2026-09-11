# @lcode/llm-replay

> llm 实现包：**从录制的事件流回放**，无密钥可跑（文档 23 §14 批次③ / §10.2 快照重放）。
> 它是"整个循环的骨架可以在不花钱、不联网的情况下被完整测试"的前提。

## 职责

- 实现 `LlmAdapter`：`stream()` 按录制脚本逐段回放 `StreamChunk`（text-delta → tool-call-delta → usage → done）
- 只读：不发起真实网络请求

## 用法

```ts
const adapter = new ReplayLlmAdapter({
  provider: 'replay',
  script: [
    { type: 'text-delta', text: '好的，' },
    { type: 'text-delta', text: '我来改。' },
    { type: 'usage', usage: { input: 10, output: 4 } },
    { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来改。' }] } },
  ],
})
```

## Known Limitations

- 骨架版为单脚本回放；`fixtures/sessions/*/events.jsonl` 驱动的录制/回放管线（`test:replay:record`）随批次 ③ 落地。
- 不模拟延迟 / 失败注入（后续按需扩展）。
