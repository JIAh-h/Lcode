import type { PluginPermissions } from '@lcode/plugin-manifest'

/** The single protocol version spoken over a plugin utility process' stdio. */
export const PLUGIN_RPC_PROTOCOL = 'lcode.rpc/1'

export type PluginCapabilityCatalog = Readonly<{
  fs: Readonly<{
    read: readonly string[]
    write: readonly string[]
  }>
  network: readonly string[]
  spawn: readonly string[]
  env: readonly string[]
}>

export function capabilityCatalogFor(
  permissions: PluginPermissions | undefined,
): PluginCapabilityCatalog {
  return {
    fs: {
      read: [...new Set(permissions?.fs?.read ?? [])],
      write: [...new Set(permissions?.fs?.write ?? [])],
    },
    network: [...new Set(permissions?.network?.domains ?? [])],
    spawn: [...new Set(permissions?.spawn?.allow ?? [])],
    env: [...new Set(permissions?.env?.read ?? [])],
  }
}

export interface PluginRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface PluginRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface PluginRpcSuccess {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface PluginRpcFailure {
  jsonrpc: '2.0'
  id: number
  error: {
    code: string
    message: string
    data?: unknown
  }
}

export type PluginRpcMessage = PluginRpcRequest | PluginRpcNotification | PluginRpcSuccess | PluginRpcFailure

export interface PluginHostInitializeParams {
  protocol: typeof PLUGIN_RPC_PROTOCOL
  plugin: Readonly<{
    id: string
    version: string
    entry: string
  }>
  workspace: Readonly<{
    root: string
    trusted: boolean
  }>
  capabilities: PluginCapabilityCatalog
}

export interface PluginHostInitializeResult {
  protocol: string
  plugin: Readonly<{
    id: string
    version: string
  }>
}

/**
 * The SDK-side context bridge. It deliberately exposes no raw filesystem,
 * shell, network, or process handles.
 */
export interface PluginContextProxy {
  readonly capabilities: PluginCapabilityCatalog
  request<T>(method: string, params?: unknown): Promise<T>
}

/** JSON-serializable description of a plugin-owned tool. Its execute function stays in the utility process. */
export interface PluginToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<{
    type: 'object'
    properties: Readonly<Record<string, Readonly<{ type: string; description?: string; enum?: readonly string[] }>>>
    required?: readonly string[]
    description?: string
  }>
  readonly card?: string
}

export interface PluginActivationContext extends PluginContextProxy {
  registerTool(spec: PluginToolSpec, execute: (args: unknown, call: Readonly<{ callId: string }>) => unknown | Promise<unknown>): Promise<void>
  registerPromptSection(id: string, content: string, order?: number): Promise<void>
  on(event: string, handler: (payload: unknown) => void | Promise<void>): Promise<void>
}
