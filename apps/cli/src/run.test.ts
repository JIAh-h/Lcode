import { describe, expect, it } from 'vitest'
import { parseRunArgs } from './run.ts'

describe('lcode run 参数', () => {
  it('只在用户显式传入时授信目标工作区', () => {
    expect(parseRunArgs(['--cwd', 'D:/repo', '--trust-workspace', '修复测试'])).toEqual({
      cwd: 'D:/repo',
      prompt: '修复测试',
      session: undefined,
      trustWorkspace: true,
    })
    expect(parseRunArgs(['继续任务'])).toMatchObject({ prompt: '继续任务', trustWorkspace: false })
  })
})
