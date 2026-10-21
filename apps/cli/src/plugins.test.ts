import { describe, expect, it } from 'vitest'
import { parsePluginCommand } from './plugins.ts'

describe('lcode plugins 参数', () => {
  it('只接受明确的本地安装与版本化生命周期命令', () => {
    expect(parsePluginCommand(['install', 'D:/plugin'])).toEqual({ action: 'install', path: 'D:/plugin' })
    expect(parsePluginCommand(['activate', 'com.example.demo', '1.0.0'])).toEqual({ action: 'activate', id: 'com.example.demo', version: '1.0.0' })
    expect(parsePluginCommand(['uninstall', 'com.example.demo'])).toBeUndefined()
    expect(parsePluginCommand(['install'])).toBeUndefined()
  })
})
