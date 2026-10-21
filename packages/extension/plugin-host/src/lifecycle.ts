import type { Context } from '@lcode/context'
import type { PluginManifest } from '@lcode/plugin-manifest'
import type { PluginCapabilityCatalog } from '@lcode/plugin-sdk'
import type { SystemPromptService } from '@lcode/system-prompt'
import type { ToolDefinition, ToolInputSchema, ToolRegistry } from '@lcode/tools'
import { ERROR_CODES, LcodeErrorImpl, isJsonValue, type Disposer, type JsonValue } from '@lcode/util'
import type { PluginHostClient } from './index.ts'

export type PluginLifecycleState = 'activating' | 'active' | 'rolling-back' | 'deactivating'

export interface PluginLifecycleTarget {
  readonly manifest: PluginManifest
  /** Absolute path inside the registry's verified, immutable snapshot. */
  readonly entryPath: string
}

export interface PluginHostStarterInput {
  readonly target: PluginLifecycleTarget
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>
}

export type PluginHostStarter = (input: PluginHostStarterInput) => Promise<PluginHostClient>

export interface PluginLifecycleManagerOptions {
  readonly context: Context
  readonly tools: ToolRegistry
  readonly systemPrompt: SystemPromptService
  readonly startHost: PluginHostStarter
}

export interface PluginInstallationStore {
  activationSource(input: { readonly id: string; readonly version: string }): Promise<PluginLifecycleTarget>
  setEnabled(input: { readonly id: string; readonly version: string; readonly enabled: boolean }): Promise<void>
  uninstall(input: { readonly id: string; readonly version: string }): Promise<void>
}

export interface ActivePlugin {
  readonly id: string
  readonly version: string
  readonly state: PluginLifecycleState
}

export interface PluginInspection extends ActivePlugin {
  readonly contributes: Readonly<{
    tools: readonly string[]
    services: readonly string[]
    promptSections: readonly string[]
  }>
  readonly capabilities: PluginCapabilityCatalog
}

/** Read-only catalog. It intentionally contains no entry path, handles, credentials, or arbitrary service lookup. */
export interface PluginInspectService {
  inspect(): readonly PluginInspection[]
}

interface LifecycleRecord {
  readonly key: string
  readonly target: PluginLifecycleTarget
  state: PluginLifecycleState
  readonly disposers: Disposer[]
  stopRequested: boolean
  host?: PluginHostClient
  settled: Promise<ActivePlugin>
}

/**
 * Core-owned plugin lifecycle transaction. Plugin code can request a declared
 * registration through RPC, but every resulting resource is owned here and is
 * removed in reverse order on every exit path.
 */
export class PluginLifecycleManager {
  #records = new Map<string, LifecycleRecord>()

  constructor(private readonly options: PluginLifecycleManagerOptions) {}

  list(): readonly ActivePlugin[] {
    return [...this.#records.values()].map(toActivePlugin)
  }

  inspect(): readonly PluginInspection[] {
    return [...this.#records.values()]
      .filter((record) => record.state === 'active' && record.host !== undefined)
      .map((record) => ({
        ...toActivePlugin(record),
        contributes: {
          tools: [...(record.target.manifest.contributes.tools ?? [])],
          services: [...(record.target.manifest.contributes.services ?? [])],
          promptSections: [...(record.target.manifest.contributes.promptSections ?? [])],
        },
        capabilities: record.host!.capabilities,
      }))
      .sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`))
  }

  activate(target: PluginLifecycleTarget): Promise<ActivePlugin> {
    const key = pluginKey(target)
    const existing = this.#records.get(key)
    if (existing !== undefined) return existing.settled

    const record: LifecycleRecord = {
      key,
      target,
      state: 'activating',
      disposers: [],
      stopRequested: false,
      settled: undefined as unknown as Promise<ActivePlugin>,
    }
    record.settled = this.#activate(record)
    this.#records.set(key, record)
    return record.settled
  }

  async deactivate(target: Pick<PluginLifecycleTarget, 'manifest'>): Promise<void> {
    await this.deactivateByKey(`${target.manifest.id}@${target.manifest.version}`)
  }

  async deactivateByKey(key: string): Promise<void> {
    const record = this.#records.get(key)
    if (record === undefined) return
    record.stopRequested = true
    try {
      await record.settled
    } catch {
      // Activation failure already rolled all resources back below.
    }
    if (this.#records.get(key) !== record || record.state !== 'active') return
    record.state = 'deactivating'
    await this.#release(record)
    this.#records.delete(key)
  }

  async uninstall(target: Pick<PluginLifecycleTarget, 'manifest'>, removeInstalled: () => Promise<void>): Promise<void> {
    await this.deactivate(target)
    await removeInstalled()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#records.values()].map(async (record) => await this.deactivate(record.target)))
  }

  async #activate(record: LifecycleRecord): Promise<ActivePlugin> {
    try {
      const host = await this.options.startHost({
        target: record.target,
        onRequest: async (method, params) => await this.#handleRegistration(record, method, params),
      })
      record.host = host
      if (record.stopRequested) {
        record.state = 'rolling-back'
        await this.#release(record)
        this.#records.delete(record.key)
        throw activationFailed('Plugin activation was cancelled by deactivation')
      }
      record.state = 'active'
      return toActivePlugin(record)
    } catch (error) {
      record.state = 'rolling-back'
      await this.#release(record)
      this.#records.delete(record.key)
      if (error instanceof LcodeErrorImpl) throw error
      throw activationFailed('Plugin activation failed', error)
    }
  }

  async #handleRegistration(record: LifecycleRecord, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ctx/registerTool':
        return this.#registerTool(record, params)
      case 'ctx/registerPromptSection':
        return this.#registerPromptSection(record, params)
      case 'ctx/registerListener':
        return this.#registerListener(record, params)
      default:
        throw undeclared(`Plugin requested unsupported context operation: ${method}`)
    }
  }

  #registerTool(record: LifecycleRecord, params: unknown): null {
    if (!isToolSpec(params)) throw activationFailed('Plugin submitted an invalid tool definition')
    if (!(record.target.manifest.contributes.tools ?? []).includes(params.name)) {
      throw undeclared(`Tool ${params.name} is not declared in the plugin manifest`)
    }
    const tool: ToolDefinition<unknown, JsonValue> = {
      name: params.name,
      description: params.description,
      inputSchema: params.inputSchema,
      execute: async (call) => {
        const host = record.host
        if (host === undefined || host.state !== 'running') throw unavailable('Plugin tool host is unavailable')
        const result = await host.request<unknown>('plugin/tool.execute', {
          name: params.name,
          args: call.parsed,
          callId: call.callId,
        })
        if (!isJsonValue(result)) throw activationFailed(`Plugin tool ${params.name} returned a non-JSON value`)
        return result
      },
    }
    this.#track(record, this.options.tools.register(tool))
    return null
  }

  #registerPromptSection(record: LifecycleRecord, params: unknown): null {
    if (!isPromptSection(params)) throw activationFailed('Plugin submitted an invalid prompt section')
    if (!(record.target.manifest.contributes.promptSections ?? []).includes(params.id)) {
      throw undeclared(`Prompt section ${params.id} is not declared in the plugin manifest`)
    }
    this.#track(record, this.options.systemPrompt.section(params.id, params.content, params.order === undefined ? undefined : { order: params.order }))
    return null
  }

  #registerListener(record: LifecycleRecord, params: unknown): null {
    if (!isListener(params)) throw activationFailed('Plugin submitted an invalid event listener')
    if (!(record.target.manifest.activation?.events ?? []).includes(params.event)) {
      throw undeclared(`Event ${params.event} is not declared in the plugin manifest`)
    }
    this.#track(record, this.options.context.events.on(params.event, async (payload) => {
      const host = record.host
      if (host === undefined || host.state !== 'running') return
      try {
        await host.request('plugin/event', { listenerId: params.listenerId, payload })
      } catch {
        // A plugin listener must never break the core event pipeline.
      }
    }))
    return null
  }

  #track(record: LifecycleRecord, disposer: Disposer): void {
    if (record.state === 'activating' || record.state === 'active') {
      record.disposers.push(disposer)
      return
    }
    disposer()
  }

  async #release(record: LifecycleRecord): Promise<void> {
    for (let index = record.disposers.length - 1; index >= 0; index--) {
      try {
        record.disposers[index]!()
      } catch {
        // Continue releasing the remaining resources; lifecycle cleanup is best effort per disposer.
      }
    }
    record.disposers.length = 0
    if (record.host !== undefined) await record.host.close()
  }
}

/** Persisted installation intent wrapped around the in-memory lifecycle transaction. */
export class InstalledPluginLifecycleService {
  constructor(
    private readonly lifecycle: PluginLifecycleManager,
    private readonly installations: PluginInstallationStore,
  ) {}

  async activate(input: { readonly id: string; readonly version: string }): Promise<ActivePlugin> {
    const target = await this.installations.activationSource(input)
    const active = await this.lifecycle.activate(target)
    try {
      await this.installations.setEnabled({ ...input, enabled: true })
      return active
    } catch (error) {
      await this.lifecycle.deactivate(target)
      throw error
    }
  }

  async deactivate(input: { readonly id: string; readonly version: string }): Promise<void> {
    await this.lifecycle.deactivateByKey(`${input.id}@${input.version}`)
    await this.installations.setEnabled({ ...input, enabled: false })
  }

  async uninstall(input: { readonly id: string; readonly version: string }): Promise<void> {
    await this.deactivate(input)
    await this.installations.uninstall(input)
  }

  inspect(): readonly PluginInspection[] { return this.lifecycle.inspect() }
}

declare module '@lcode/context' {
  interface Services {
    plugins: PluginInspectService
  }
}

function pluginKey(target: PluginLifecycleTarget): string {
  return `${target.manifest.id}@${target.manifest.version}`
}

function toActivePlugin(record: LifecycleRecord): ActivePlugin {
  return { id: record.target.manifest.id, version: record.target.manifest.version, state: record.state }
}

function isToolSpec(value: unknown): value is { name: string; description: string; inputSchema: ToolInputSchema } {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.description !== 'string') return false
  const schema = value.inputSchema
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) return false
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) return false
  return Object.values(schema.properties).every((property) => isRecord(property) && typeof property.type === 'string')
}

function isPromptSection(value: unknown): value is { id: string; content: string; order?: number } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.content === 'string' && (value.order === undefined || typeof value.order === 'number')
}

function isListener(value: unknown): value is { event: string; listenerId: string } {
  return isRecord(value) && typeof value.event === 'string' && typeof value.listenerId === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function activationFailed(message: string, cause?: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EX_ACTIVATION_FAILED, message, userMessage: '这个扩展启动失败，已回滚本次加载。', retryable: false, ...(cause === undefined ? {} : { cause }) })
}

function undeclared(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EX_UNDECLARED_PERMISSION, message, userMessage: '这个扩展请求了未声明的能力，已拒绝。', retryable: false })
}

function unavailable(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EX_HOST_UNAVAILABLE, message, userMessage: '扩展进程已停止，当前功能不可用。', retryable: false })
}
