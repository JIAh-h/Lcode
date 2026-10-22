import type { Context } from '@lcode/context'
import type { InternalBundleEntry, RuntimeDisposer, RuntimeProfile } from '@lcode/runtime-composition'

/** 当前发行包支持的内置运行时组合。第三方插件不属于这个联合。 */
export type BuiltinRuntimeProfileId = 'desktop-default' | 'cli-default'

/**
 * 可信内置 Provider 按领域组合；spine 只保留 agent 编排和会话期协作。
 * Profile 不解释用户配置，也不把第三方 manifest 放进 root Context。
 */
export function createBuiltinRuntimeProfile(
  id: BuiltinRuntimeProfileId,
  mountSessions: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountExecution: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountTooling: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountModelRouting: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountPolicy: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountExtensions: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountCodeRuntime: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountAgent: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  mountSpine: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>,
  extras: readonly InternalBundleEntry[] = [],
): RuntimeProfile {
  const sessions: InternalBundleEntry = {
    id: 'sessions-local',
    provides: ['sessions'],
    mount: mountSessions,
  }
  const execution: InternalBundleEntry = {
    id: 'execution-local',
    requires: ['sessions'],
    provides: ['subprocess', 'sandbox', 'fs', 'jobs', 'shell', 'terminals', 'compactionPrune', 'spill'],
    mount: mountExecution,
  }
  const spine: InternalBundleEntry = {
    id: 'lcode-spine',
    requires: ['sessions', 'agentLoop', 'agents', 'contextSources', 'contextBudget', 'compaction', 'skills', 'presets', 'plugins'],
    provides: [],
    mount: mountSpine,
  }
  const tooling: InternalBundleEntry = {
    id: 'tooling-local',
    requires: ['sessions', 'fs', 'shell', 'terminals', 'spill'],
    provides: ['tools', 'systemPrompt'],
    mount: mountTooling,
  }
  const modelRouting: InternalBundleEntry = {
    id: 'model-routing-local',
    requires: ['llm', 'agentDefaultModel'],
    provides: ['modelRouting'],
    mount: mountModelRouting,
  }
  const model: InternalBundleEntry = {
    id: 'model-local',
    requires: ['llm', 'agentDefaultModel'],
    adopts: ['llm', 'agentDefaultModel'],
    provides: [],
    mount: () => () => {},
  }
  const policy: InternalBundleEntry = {
    id: 'policy-local',
    requires: ['sessions', 'tools', 'systemPrompt', 'sandbox', 'fs'],
    provides: ['permissionPresets', 'workspaceTrust', 'planMode', 'subagents'],
    mount: mountPolicy,
  }
  const extensions: InternalBundleEntry = {
    id: 'extensions-local',
    requires: ['tools', 'systemPrompt', 'subprocess', 'sandbox', 'workspaceTrust'],
    provides: ['skills', 'presets', 'plugins'],
    mount: mountExtensions,
  }
  const codeRuntime: InternalBundleEntry = {
    id: 'code-runtime-local',
    requires: ['tools', 'subprocess', 'sandbox'],
    provides: ['codeRuntime'],
    mount: mountCodeRuntime,
  }
  const agent: InternalBundleEntry = {
    id: 'agent-local',
    requires: ['llm', 'agentDefaultModel', 'modelRouting', 'sessions', 'tools', 'systemPrompt', 'jobs', 'terminals'],
    provides: ['agentLoop', 'agents', 'contextSources', 'contextBudget', 'compaction'],
    mount: mountAgent,
  }
  return { id, bundles: [sessions, execution, tooling, model, modelRouting, policy, extensions, codeRuntime, agent, spine, ...extras] }
}
