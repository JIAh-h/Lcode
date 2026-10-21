import { createAgentRuntime } from '@lcode/lcode-desktop'
import { resolveLcodeHome } from '@lcode/util'

type PluginCommand =
  | { readonly action: 'list' | 'inspect' }
  | { readonly action: 'install'; readonly path: string }
  | { readonly action: 'activate' | 'deactivate' | 'uninstall'; readonly id: string; readonly version: string }

/** Parse the deliberately small, local-only plugin management grammar. */
export function parsePluginCommand(argv: readonly string[]): PluginCommand | undefined {
  const [action, first, second] = argv
  if (action === 'list' || action === 'inspect') return { action }
  if (action === 'install' && typeof first === 'string' && first !== '') return { action, path: first }
  if ((action === 'activate' || action === 'deactivate' || action === 'uninstall') && typeof first === 'string' && first !== '' && typeof second === 'string' && second !== '') {
    return { action, id: first, version: second }
  }
  return undefined
}

export async function runPluginsCommand(argv: readonly string[]): Promise<number> {
  const command = parsePluginCommand(argv)
  if (command === undefined) {
    console.error('用法：lcode plugins list|inspect | install <目录> | activate|deactivate|uninstall <id> <version>')
    return 1
  }
  const runtime = await createAgentRuntime({ home: resolveLcodeHome(), profile: 'cli-default' })
  try {
    if (command.action === 'list') {
      const active = new Set(runtime.plugins.inspect().map((entry) => `${entry.id}@${entry.version}`))
      console.log(JSON.stringify(runtime.plugins.list().map((entry) => ({
        id: entry.id,
        version: entry.version,
        state: entry.state,
        active: active.has(`${entry.id}@${entry.version}`),
        source: entry.source,
        permissions: entry.permissions,
        contributes: entry.contributes,
      })), null, 2))
      return 0
    }
    if (command.action === 'inspect') {
      console.log(JSON.stringify(runtime.plugins.inspect(), null, 2))
      return 0
    }
    if (command.action === 'install') {
      console.log(JSON.stringify(await runtime.plugins.installLocal(command.path), null, 2))
      return 0
    }
    if (command.action === 'activate' || command.action === 'deactivate' || command.action === 'uninstall') {
      if (command.action === 'activate') await runtime.plugins.activate(command)
      if (command.action === 'deactivate') await runtime.plugins.deactivate(command)
      if (command.action === 'uninstall') await runtime.plugins.uninstall(command)
      console.log(JSON.stringify({ ok: true, action: command.action, id: command.id, version: command.version }))
      return 0
    }
    return 1
  } catch (error) {
    const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
    const message = typeof error === 'object' && error !== null && typeof (error as { userMessage?: unknown }).userMessage === 'string'
      ? (error as { userMessage: string }).userMessage
      : error instanceof Error ? error.message : String(error)
    console.error(code === undefined ? message : `${code} — ${message}`)
    return 1
  } finally {
    await runtime.dispose()
  }
}
