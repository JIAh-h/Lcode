import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildUserContent } from './user-content.ts'

const skills = {
  catalog: async () => [{ id: 'review', name: 'Review' }],
  load: async (id: string) => (id === 'review' ? { instructions: '检查改动。' } : undefined),
}

describe('buildUserContent', () => {
  it('技能在文本之前、图片在最后；指令只进内容块，不拼进用户文本', async () => {
    const blocks = await buildUserContent({
      text: '看图',
      skills: ['review'],
      images: [{ mediaType: 'image/jpeg', data: 'AAAA' }],
      skillsService: skills,
    })
    expect(blocks).toEqual([
      { type: 'skill', id: 'review', name: 'Review', instructions: '检查改动。' },
      { type: 'text', text: '看图' },
      { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' },
    ])
  })

  it('允许只有图片；未知技能被跳过', async () => {
    const blocks = await buildUserContent({
      text: '',
      skills: ['missing'],
      images: [{ mediaType: 'image/png', data: 'BBBB' }],
      skillsService: skills,
    })
    expect(blocks).toEqual([{ type: 'image', mediaType: 'image/png', data: 'BBBB' }])
    await expect(buildUserContent({ text: '', skills: [], images: [], skillsService: skills })).rejects.toThrow()
  })

  it('提供附件存储时只把引用写进消息，不内联 base64', async () => {
    const blocks = await buildUserContent({
      text: '看图',
      images: [{ mediaType: 'image/jpeg', data: 'AAAA' }],
      skillsService: skills,
      attachmentStore: { put: () => ({ hash: 'a'.repeat(64), bytes: 3 }) },
    })
    expect(blocks).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image-ref', mediaType: 'image/jpeg', hash: 'a'.repeat(64), bytes: 3 },
    ])
  })

  it('拒绝未知 MIME 与超界 base64', async () => {
    await expect(buildUserContent({
      text: 'x',
      images: [{ mediaType: 'image/svg+xml', data: 'AAAA' }],
      skillsService: skills,
    })).rejects.toThrow('图片格式')
    await expect(buildUserContent({
      text: 'x',
      images: [{ mediaType: 'image/png', data: 'A'.repeat(8_000_001) }],
      skillsService: skills,
    })).rejects.toThrow('图片格式')
  })

  it('文件附件把正文随消息发送，而不是只留路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcode-attach-'))
    try {
      const file = join(dir, '笔记.md')
      writeFileSync(file, '# 标题\n正文内容', 'utf8')
      const blocks = await buildUserContent({
        text: '看看这个',
        attachments: [{ path: file, kind: 'file' }],
        skillsService: skills,
      })
      expect(blocks).toEqual([
        { type: 'text', text: '看看这个' },
        {
          type: 'file-ref',
          kind: 'file',
          path: file,
          name: '笔记.md',
          content: '# 标题\n正文内容',
          bytes: expect.any(Number),
        },
      ])
      expect(JSON.stringify(blocks)).not.toContain('附件引用')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件夹附件发送目录结构，跳过依赖目录与符号链接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcode-attach-'))
    try {
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'src', 'index.ts'), 'export {}', 'utf8')
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8')
      const blocks = await buildUserContent({
        text: '',
        attachments: [{ path: dir, kind: 'folder' }],
        skillsService: skills,
      })
      const block = blocks[0]
      expect(block).toMatchObject({ type: 'file-ref', kind: 'folder', path: dir })
      if (block?.type !== 'file-ref') throw new Error('missing file-ref')
      expect(block.content).toContain('- src/')
      expect(block.content).toContain('- src/index.ts')
      expect(block.content).not.toContain('node_modules')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('二进制与超长文件不内联全文，并标记可继续读取', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcode-attach-'))
    try {
      const binary = join(dir, 'blob.bin')
      writeFileSync(binary, Buffer.from([0, 1, 2, 3]))
      const long = join(dir, 'long.txt')
      writeFileSync(long, 'a'.repeat(40_001), 'utf8')
      const blocks = await buildUserContent({
        text: '检查',
        attachments: [{ path: binary, kind: 'file' }, { path: long, kind: 'file' }],
        skillsService: skills,
      })
      const [bin, text] = blocks.filter((block) => block.type === 'file-ref')
      expect(bin).toMatchObject({ type: 'file-ref', binary: true })
      if (bin?.type !== 'file-ref') throw new Error('missing binary block')
      expect(bin.content).toContain('二进制文件')
      expect(text).toMatchObject({ type: 'file-ref', truncated: true })
      if (text?.type !== 'file-ref') throw new Error('missing text block')
      expect(text.content).toHaveLength(40_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('丢失的附件留下可读说明，相对路径直接忽略', async () => {
    const blocks = await buildUserContent({
      text: '在吗',
      attachments: [{ path: join(tmpdir(), 'lcode-missing-attachment.txt'), kind: 'file' }, { path: 'relative.txt', kind: 'file' }],
      skillsService: skills,
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ type: 'file-ref' })
    if (blocks[1]?.type !== 'file-ref') throw new Error('missing file-ref')
    expect(blocks[1].content).toContain('无法读取')
  })
})
