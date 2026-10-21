import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { PLUGIN_MANIFEST_SCHEMA, parsePluginManifest } from '@lcode/plugin-manifest'
import { createSystemPromptService } from '@lcode/system-prompt'
import { InMemoryToolRegistry } from '@lcode/tools'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import { createPluginHost } from './index.ts'
import { InstalledPluginLifecycleService, PluginLifecycleManager, type PluginLifecycleTarget } from './lifecycle.ts'

const runnerPath = fileURLToPath(new URL('./utility-runner.mjs', import.meta.url))
const manifest = parsePluginManifest({
  $schema: PLUGIN_MANIFEST_SCHEMA,
  id: 'com.example.lifecycle',
  name: 'Lifecycle fixture',
  version: '1.0.0',
  engines: { lcode: '>=0.1.0 <1.0.0' },
  entry: './dist/index.js',
  permissions: { fs: { read: ['${workspace}/docs/**'] }, network: { domains: ['api.example.com'] } },
  activation: { events: ['demo/one', 'demo/two'] },
  contributes: {
    tools: ['demo/first', 'demo/second', 'demo/status'],
    promptSections: ['demo/hint'],
  },
})

describe('PluginLifecycleManager', () => {
  it('activates a verified entry, then reverses tools, prompt sections, listeners and host on deactivation', async () => {
    await withPlugin(pluginSource, async (target) => {
      const h = harness()
      const active = await h.manager.activate(target)
      expect(active.state).toBe('active')
      expect(h.manager.inspect()).toEqual([{
        id: manifest.id,
        version: manifest.version,
        state: 'active',
        contributes: { tools: ['demo/first', 'demo/second', 'demo/status'], services: [], promptSections: ['demo/hint'] },
        capabilities: { fs: { read: ['${workspace}/docs/**'], write: [] }, network: ['api.example.com'], spawn: [], env: [] },
      }])
      expect(h.tools.schemas().map((tool) => tool.name)).toEqual(['demo/first', 'demo/second', 'demo/status'])
      await expect(h.prompt.assemble({})).resolves.toMatchObject({ system: 'Lifecycle hint' })

      await h.context.emit('demo/one' as never, { value: 1 } as never)
      await h.context.emit('demo/two' as never, { value: 2 } as never)
      const result = await h.tools.execute(
        { callId: 'status-1', name: 'demo/status', arguments: '{}' },
        { signal: new AbortController().signal },
      )
      expect(result).toMatchObject({ ok: true, value: { events: 2 } })

      await h.manager.deactivate(target)
      expect(h.manager.list()).toEqual([])
      expect(h.manager.inspect()).toEqual([])
      expect(h.tools.schemas()).toEqual([])
      await expect(h.prompt.assemble({})).resolves.toMatchObject({ system: '' })
      await h.context.emit('demo/one' as never, { value: 3 } as never)
    })
  })

  it('rolls back registrations when the entry fails during activation', async () => {
    await withPlugin(failingPluginSource, async (target) => {
      const h = harness()
      await expect(h.manager.activate(target)).rejects.toMatchObject({ code: 'EX-ACTIVATION_FAILED' })
      expect(h.manager.list()).toEqual([])
      expect(h.tools.schemas()).toEqual([])
      await expect(h.prompt.assemble({})).resolves.toMatchObject({ system: '' })
    })
  })

  it('cancels an in-flight activation and releases registrations that arrive before it settles', async () => {
    await withPlugin(delayedPluginSource, async (target) => {
      const h = harness()
      const activating = h.manager.activate(target)
      await h.manager.deactivate(target)
      await expect(activating).rejects.toMatchObject({ code: 'EX-ACTIVATION_FAILED' })
      expect(h.manager.list()).toEqual([])
      expect(h.tools.schemas()).toEqual([])
    })
  })

  it('persists enabled intent only after activation and removes the installation after teardown', async () => {
    await withPlugin(pluginSource, async (target) => {
      const h = harness()
      const transitions: boolean[] = []
      let removed = false
      const service = new InstalledPluginLifecycleService(h.manager, {
        activationSource: async () => target,
        setEnabled: async ({ enabled }) => { transitions.push(enabled) },
        uninstall: async () => { removed = true },
      })
      await service.activate({ id: manifest.id, version: manifest.version })
      await service.uninstall({ id: manifest.id, version: manifest.version })

      expect(transitions).toEqual([true, false])
      expect(removed).toBe(true)
      expect(h.manager.list()).toEqual([])
      expect(h.tools.schemas()).toEqual([])
    })
  })
})

function harness() {
  const context = createContext()
  const tools = new InMemoryToolRegistry(context)
  const prompt = createSystemPromptService(tools)
  const manager = new PluginLifecycleManager({
    context,
    tools,
    systemPrompt: prompt,
    startHost: async ({ target, onRequest }) => await createPluginHost({
      manifest: target.manifest,
      argv: [process.execPath, runnerPath, target.entryPath],
      cwd: process.cwd(),
      workspace: { root: process.cwd(), trusted: true },
      subprocess: createLocalSubprocess(),
      sandbox: { policy: { kind: 'test' }, wrap: async (argv) => ({ enforced: true, wrappedArgv: argv }) },
      onRequest,
    }),
  })
  return { context, tools, prompt, manager }
}

async function withPlugin(source: string, run: (target: PluginLifecycleTarget) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lcode-plugin-lifecycle-'))
  const entryPath = join(root, 'index.mjs')
  await writeFile(entryPath, source)
  try {
    await run({ manifest, entryPath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const pluginSource = String.raw`
let events = 0
export async function activate(ctx) {
  await ctx.registerTool({ name: 'demo/first', description: 'first', inputSchema: { type: 'object', properties: {} } }, async () => ({ first: true }))
  await ctx.registerTool({ name: 'demo/second', description: 'second', inputSchema: { type: 'object', properties: {} } }, async () => ({ second: true }))
  await ctx.registerTool({ name: 'demo/status', description: 'status', inputSchema: { type: 'object', properties: {} } }, async () => ({ events }))
  await ctx.registerPromptSection('demo/hint', 'Lifecycle hint')
  await ctx.on('demo/one', async () => { events += 1 })
  await ctx.on('demo/two', async () => { events += 1 })
}
`

const failingPluginSource = String.raw`
export async function activate(ctx) {
  await ctx.registerTool({ name: 'demo/first', description: 'first', inputSchema: { type: 'object', properties: {} } }, async () => ({ first: true }))
  throw new Error('fixture activation failure')
}
`

const delayedPluginSource = String.raw`
export async function activate(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 30))
  await ctx.registerTool({ name: 'demo/first', description: 'first', inputSchema: { type: 'object', properties: {} } }, async () => ({ first: true }))
}
`
