import { describe, expect, it } from 'vitest'
import { createLocalSubprocess } from './local-subprocess.ts'

const node = process.execPath

describe('LocalSubprocess', () => {
  it('保留 stdout/stderr 与退出事实', async () => {
    const subprocess = createLocalSubprocess()
    const child = await subprocess.spawn({
      argv: [node, '-e', 'process.stdout.write("out"); process.stderr.write("err")'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null })
    expect(child.pid).toBeGreaterThan(0)
    expect(stdout).toBe('out')
    expect(stderr).toBe('err')
  })

  it('AbortSignal 调用统一的进程树清理', async () => {
    const subprocess = createLocalSubprocess()
    const controller = new AbortController()
    const child = await subprocess.spawn({ argv: [node, '-e', 'setTimeout(() => {}, 10000)'], signal: controller.signal })
    controller.abort()
    const exited = await child.exited
    expect(exited.code === null || exited.code !== 0 || exited.signal !== null).toBe(true)
  })
})
