import { defineConfig } from 'vitest/config'

// 单元 + 集成测试（文档 23 §10：默认测试必须离线可过）
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // 核心包逐文件 100% 的阶梯在 CI 配；本地跑全量
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
})
