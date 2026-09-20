import { describe, expect, it } from 'vitest'
import { platformSandboxCapabilities } from './capabilities.ts'

describe('P5-01 平台能力矩阵', () => {
  it.each([
    ['win32', 'AppContainer + Job Object'],
    ['darwin', 'Seatbelt'],
    ['linux', 'Landlock + seccomp'],
  ])('%s 不把计划中的 %s 伪装成已保护', (platform, plannedMechanism) => {
    const capabilities = platformSandboxCapabilities(platform)
    expect(capabilities.mechanism).toBe('none')
    expect(capabilities.reason).toBeTruthy()
    for (const boundary of Object.values(capabilities.boundaries)) {
      expect(boundary.state).toBe('unavailable')
      expect(boundary.plannedMechanism).toBe(plannedMechanism)
      expect(boundary.message).toContain('尚未受到')
    }
  })
})
