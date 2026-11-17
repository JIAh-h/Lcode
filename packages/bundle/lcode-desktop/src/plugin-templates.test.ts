import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../../extension/plugin-manifest/src/manifest.ts'

/**
 * 创造模式模板的**可用性**测试（docs/30 §6）。
 *
 * 为什么必须有这一条：模板是"模型造插件时的起点"，一旦模板本身不合规，
 * 创造模式就会稳定地生产装不上的插件——而这**不会在任何地方报错**，
 * 直到用户点安装才失败（实测踩过：四个模板里三个的 schema 与 entry
 * 写错，只有做过端到端验证的那个是对的）。
 *
 * 所以这里拿着**真实的解析器**跑一遍全部模板，而不是校验字段拼写。
 */
const TEMPLATES_DIR = fileURLToPath(
  // src → lcode-desktop → bundle → packages → 仓库根
  new URL('../../../../apps/desktop/resources/skills/lcode-plugin-creator/templates', import.meta.url),
)

function templateDirs(): readonly string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => statSync(join(TEMPLATES_DIR, name)).isDirectory())
    .sort()
}

describe('创造模式模板可被真实解析器接受', () => {
  it('至少存在四个模板（工具 / 提示词 / 监听器 / 主题）', () => {
    expect(templateDirs().length).toBeGreaterThanOrEqual(4)
  })

  it.each(templateDirs())('%s 的 lcode.json 通过 parsePluginManifest', (name) => {
    const raw = JSON.parse(readFileSync(join(TEMPLATES_DIR, name, 'lcode.json'), 'utf8')) as unknown
    // 不 catch：解析失败就是模板不可用，测试必须红
    expect(() => parsePluginManifest(raw)).not.toThrow()
  })

  it.each(templateDirs())('%s 的 manifest 与目录结构自洽', (name) => {
    const raw = JSON.parse(readFileSync(join(TEMPLATES_DIR, name, 'lcode.json'), 'utf8')) as unknown
    const manifest = parsePluginManifest(raw)
    const dir = join(TEMPLATES_DIR, name)

    // entry 指向的文件必须真的存在（缺了就是安装后 activate 必炸）
    expect(() => statSync(join(dir, manifest.entry))).not.toThrow()
    // package.json 必须声明 type: module——否则 Node 会二次解析并告警（实测）
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { type?: string }
    expect(pkg.type).toBe('module')
    // client 入口（若有）也必须存在
    if (manifest.contributes.client !== undefined) {
      expect(() => statSync(join(dir, manifest.contributes.client!.entry))).not.toThrow()
    }
  })
})
