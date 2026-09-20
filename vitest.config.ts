import { defineConfig } from 'vitest/config'

// 单元 + 集成测试（文档 23 §10：默认测试必须离线可过）
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/cli/src/**/*.test.ts', 'apps/desktop/renderer/**/*.test.tsx'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // T7.2：核心包逐文件 100%。不把非核心包混入核心门槛，避免总百分比掩盖单个核心文件的缺口。
      include: ['packages/core/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      all: true,
      reporter: ['text', 'json-summary'],
    },
  },
})
