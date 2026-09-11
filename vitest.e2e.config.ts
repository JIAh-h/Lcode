import { defineConfig } from 'vitest/config'

// 真实模型 e2e（文档 23 §10.3：无 DEEPSEEK_API_KEY 时自动跳过，不失败）
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
})
