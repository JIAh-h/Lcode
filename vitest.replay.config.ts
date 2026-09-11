import { defineConfig } from 'vitest/config'

// 快照重放测试（文档 23 §10.2：无密钥可跑）
// 骨架阶段 fixture 尚为空，配置先就位，测试随批次 ③（llm-replay）落地
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.replay.test.ts'],
    environment: 'node',
  },
})
