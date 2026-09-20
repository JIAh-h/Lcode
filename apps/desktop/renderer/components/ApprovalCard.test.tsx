import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalCard } from './ApprovalCard.tsx'

describe('ApprovalCard', () => {
  it('回放完整影响面与 fail-closed 决定，不暴露环境变量值', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        callId="call-approval-1"
        action={{ tool: 'shell', summary: '运行部署命令', argv: ['pnpm', 'deploy'] }}
        basis={{ source: 'preset', presetName: '标准', reason: '该命令未在项目中出现过' }}
        impact={{
          paths: [{ path: 'C:/outside/.env', mode: 'write', outsideWorkspace: true }],
          network: { domains: ['deploy.example.com'] },
          env: ['DEPLOY_TOKEN'],
          sandboxChange: { from: 'read-only', to: 'workspace-write' },
          sandbox: { status: 'degraded', mechanism: 'none', reason: 'Windows 原生隔离尚未接入' },
          processScope: '当前会话',
        }}
        decision={{ result: 'unavailable', decidedBy: 'auto-denied' }}
      />,
    )

    expect(html).toContain('无人应答，已安全拒绝')
    expect(html).toContain('C:/outside/.env')
    expect(html).toContain('deploy.example.com')
    expect(html).toContain('read-only')
    expect(html).toContain('Windows 原生隔离尚未接入')
    expect(html).toContain('DEPLOY_TOKEN')
    expect(html).not.toContain('secret-value')
  })
})
