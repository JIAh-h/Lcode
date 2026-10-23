import { describe, expect, it } from 'vitest'
import { matchSlashCommands, parseSlashInput } from './slashCommands.ts'

describe('斜杠命令解析', () => {
  it('解析命令与参数，只接受单行命令形状', () => {
    expect(parseSlashInput('/model')).toEqual({ name: 'model', args: '' })
    expect(parseSlashInput('/model fake-b')).toEqual({ name: 'model', args: 'fake-b' })
    expect(parseSlashInput('/COMPACT')).toEqual({ name: 'compact', args: '' })
    expect(parseSlashInput('/usr/bin/env')).toBeNull()
    expect(parseSlashInput('hello /model')).toBeNull()
    expect(parseSlashInput('/model\nmore')).toBeNull()
    expect(parseSlashInput('not a command')).toBeNull()
  })

  it('按前缀筛选；完整命令带参数时只保留自身', () => {
    expect(matchSlashCommands('', '').length).toBeGreaterThan(5)
    expect(matchSlashCommands('co', '').map((command) => command.name)).toEqual(['compact', 'context'])
    expect(matchSlashCommands('compact', '2')).toEqual([expect.objectContaining({ name: 'compact' })])
    expect(matchSlashCommands('nope', '')).toEqual([])
  })
})
