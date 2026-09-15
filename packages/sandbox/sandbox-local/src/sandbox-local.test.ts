import { describe, expect, it } from 'vitest'
import { createLocalSandbox } from './sandbox-local.ts'

/**
 * `sandbox-local` 验收（12 §4.2 / §4.7；14 §3.5 的分批发布策略）。
 *
 * 这个实现的全部价值就是**如实**：它没有约束能力，所以必须明说 `enforced: false`，
 * 并给一句人能看懂的原因。假装有沙箱是这里能犯的最严重的错误——
 * 用户会以为自己受保护，实际裸跑。
 */

const policy = { mode: 'workspace-write' as const, workspaceRoot: '/repo/web' }

describe('status：如实报告"没有沙箱"', () => {
  it('available=false、effectively degraded=true，且给出可读原因', async () => {
    const s = createLocalSandbox()
    const status = await s.status()
    expect(status.available).toBe(false)
    expect(status.degraded).toBe(true)
    expect(status.mechanism).toBe('none')
    // 原因必须非空：用户看到"为什么没沙箱"比只看到一个布尔有用得多
    expect(status.reason).toBeTruthy()
    expect(typeof status.reason).toBe('string')
  })

  it('列出已知的逃逸面（不掩饰）', async () => {
    const status = await createLocalSandbox().status()
    expect(status.knownEscapeSurfaces.length).toBeGreaterThan(0)
  })

  it('原因可以覆盖（平台实现接入后用于标注"为什么降级"）', async () => {
    const status = await createLocalSandbox({ reason: '这套 Windows 版本不支持 AppContainer' }).status()
    expect(status.reason).toBe('这套 Windows 版本不支持 AppContainer')
  })
})

describe('wrap：原样返回 argv，但**不假装** enforced', () => {
  it('argv 不变', async () => {
    const s = createLocalSandbox()
    const r = await s.wrap(['node', '-e', '0'], policy)
    expect(r.wrappedArgv).toEqual(['node', '-e', '0'])
  })

  it('**enforced=false**，且带上降级原因', async () => {
    const r = await createLocalSandbox().wrap(['ls'], policy)
    expect(r.enforced).toBe(false)
    expect(r.degradationReason).toBeTruthy()
  })

  it('不生成 profile（没有 profile 才是诚实的）', async () => {
    const r = await createLocalSandbox().wrap(['ls'], policy)
    expect(r.profile).toBeUndefined()
  })

  it('返回的是**新数组**（调用方改它不会污染自己的输入）', async () => {
    const input = ['ls']
    const r = await createLocalSandbox().wrap(input, policy)
    expect(r.wrappedArgv).not.toBe(input)
  })

  it('各档位一视同仁：它没有强制能力，所以不按档位"演"', async () => {
    const s = createLocalSandbox()
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const r = await s.wrap(['echo', 'x'], { mode, workspaceRoot: '/repo' })
      // 若按档位返回不同的 enforced，就是在假装 —— read-only 下返回 enforced:true
      // 而实际不做任何限制，会让"只读"变成一句空话
      expect(r.enforced).toBe(false)
    }
  })
})
