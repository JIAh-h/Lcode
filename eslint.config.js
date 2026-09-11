// ESLint 9 flat config（文档 23 §7 代码规范的最低落地）
// 骨架阶段只拦最硬的两条：禁用 any（例外需注释）与深路径导入；完整规则集随批次推进补齐
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/lib/**', '**/node_modules/**', 'prototype/**', 'docs/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: false }],
      // 文档 20 §3.1：跨包只用包名，禁止深层导入
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@lcode/*/src/*'],
              message: '跨包引用必须使用包名（@lcode/<pkg>），禁止深层导入 src 路径',
            },
          ],
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
)
