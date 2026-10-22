import { describe, expect, it } from 'vitest'
import { InMemoryAgentDefaultModelService } from '@lcode/agent-default-model'
import { createContext } from '@lcode/context'
import { InMemoryLlmRegistry } from '@lcode/llm'
import type { LlmAdapter } from '@lcode/llm'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import type { ErrorCode } from '@lcode/util'
import { LocalModelApi } from './model-api.ts'
import type { ModelSelection } from './types.ts'

function makeApi(opts: {
  adapters?: LlmAdapter[]
  configureModel?: boolean
  probeTimeoutMs?: number
} = {}): { api: LocalModelApi; models: InMemoryAgentDefaultModelService } {
  const ctx = createContext()
  const models = new InMemoryAgentDefaultModelService()
  if (opts.configureModel !== false) {
    void models.set({ provider: 'replay', model: 'replay-model' })
  }
  const llm = new InMemoryLlmRegistry()
  for (const adapter of opts.adapters ?? [new ReplayLlmAdapter({ provider: 'replay', model: 'replay-model', chunks: [] })]) {
    llm.register(adapter)
  }
  ctx.set('agentDefaultModel', models)
  ctx.set('llm', llm)
  const api = new LocalModelApi({ ctx, ...(opts.probeTimeoutMs !== undefined ? { probeTimeoutMs: opts.probeTimeoutMs } : {}) })
  return { api, models }
}

function failingAdapter(code: ErrorCode, id = 'failing'): LlmAdapter {
  return {
    providerInfo: () => ({ id, name: id, capabilities: { streaming: true, reasoning: true, toolCalls: true } }),
    listModels: async () => {
      throw new LcodeErrorImpl({ code, message: `boom: ${code}`, userMessage: '失败', retryable: false })
    },
    resolveModel: async (sel) => ({ provider: sel.provider, model: sel.model }),
    prepareCall: async (sel) => ({
      provider: sel.provider,
      model: sel.model,
      request: { endpoint: 'replay://', headers: {}, body: {} },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false },
    }),
    stream: async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [] } }
    },
    providerRetryPolicy: () => ({ maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false }),
  }
}

describe('model.listProviders / listModels', () => {
  it('listProviders：返回已注册供应商元信息', async () => {
    const { api } = await makeApi()
    const providers = await api.listProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ id: 'replay', name: 'replay' })
  })

  describe('model.modelLimits', () => {
    it('优先用 describeModel 的详情字段', async () => {
      let called = 0
      const adapter: LlmAdapter = {
        ...failingAdapter(ERROR_CODES.EL_MODEL_ERROR, 'meta'),
        describeModel: async () => {
          called += 1
          return { contextWindow: 129_024, maxOutputTokens: 8_192 }
        },
      }
      const { api } = makeApi({ adapters: [adapter] })
      await expect(api.modelLimits({ provider: 'meta', model: 'deepseek-v4.1-flash' })).resolves.toEqual({
        contextWindow: 129_024,
        maxOutputTokens: 8_192,
      })
      expect(called).toBe(1)
    })

    it('详情不可用时回落到列表；两者都失败或供应商不存在时返回空对象', async () => {
      const listOnly: LlmAdapter = {
        ...failingAdapter(ERROR_CODES.EL_MODEL_ERROR, 'list'),
        listModels: async () => [{ id: 'm', contextWindow: 200_000 }],
      }
      const { api } = makeApi({ adapters: [listOnly, failingAdapter(ERROR_CODES.EL_MODEL_ERROR, 'broken')] })
      await expect(api.modelLimits({ provider: 'list', model: 'm' })).resolves.toEqual({ contextWindow: 200_000 })
      await expect(api.modelLimits({ provider: 'broken', model: 'm' })).resolves.toEqual({})
      await expect(api.modelLimits({ provider: 'missing', model: 'm' })).resolves.toEqual({})
    })
  })

  it('listModels：回放适配器返回内置清单；未知 provider → EL-NO_ADAPTER；空名 → EC-INVALID_PARAMS', async () => {
    const { api } = await makeApi()
    await expect(api.listModels({ provider: 'replay' })).resolves.toEqual([{ id: 'replay-model' }])
    await expect(api.listModels({ provider: 'ghost' })).rejects.toMatchObject({ code: 'EL-NO_ADAPTER' })
    await expect(api.listModels({ provider: '' })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
  })
})

describe('model.probe（六类归因，永不抛错）', () => {
  it('成功：{ ok: true, models }', async () => {
    const { api } = await makeApi()
    const result = await api.probe({ provider: 'replay' })
    expect(result).toEqual({ ok: true, models: [{ id: 'replay-model' }] })
  })

  it('已选择模型以实际调用为准，不因 /models 漏列而误报 model-not-found', async () => {
    const { api } = await makeApi()
    const result = await api.probe({ provider: 'replay', model: 'nope' })
    expect(result).toEqual({ ok: true, models: [{ id: 'nope' }] })
  })

  it('实际调用返回 EL-UNKNOWN_MODEL 才归因为 model-not-found', async () => {
    const rejected = failingAdapter(ERROR_CODES.EL_UNKNOWN_MODEL)
    rejected.stream = async function* () {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_UNKNOWN_MODEL,
        message: 'server rejected model',
        userMessage: '模型不存在',
        retryable: false,
      })
    }
    const { api } = await makeApi({ adapters: [rejected] })
    const result = await api.probe({ provider: 'failing', model: 'nope' })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'model-not-found', code: 'EL-UNKNOWN_MODEL' } })
  })

  it('EL-NO_ADAPTER → endpoint-unreachable（保留原始 code）', async () => {
    const { api } = await makeApi()
    const result = await api.probe({ provider: 'ghost' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('endpoint-unreachable')
      expect(result.failure.code).toBe('EL-NO_ADAPTER')
    }
  })

  it('四类供应商侧归因各自成立', async () => {
    const cases: ReadonlyArray<readonly [ErrorCode, string]> = [
      [ERROR_CODES.EL_CREDENTIAL_REJECTED, 'credential-rejected'],
      [ERROR_CODES.EL_ENDPOINT_UNREACHABLE, 'endpoint-unreachable'],
      [ERROR_CODES.EL_PROVIDER_NOT_RUNNING, 'provider-not-running'],
      [ERROR_CODES.EL_CREDENTIAL_MISSING, 'not-configured'],
    ]
    for (const [code, kind] of cases) {
      const { api } = await makeApi({ adapters: [failingAdapter(code)] })
      const result = await api.probe({ provider: 'failing' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.kind).toBe(kind)
        expect(result.failure.code).toBe(code)
      }
    }
  })

  it('超时 → timeout 归因（注入短超时）', async () => {
    const hanging: LlmAdapter = {
      providerInfo: () => ({ id: 'hanging', name: 'hanging', capabilities: { streaming: true, reasoning: true, toolCalls: true } }),
      listModels: (_signal) => new Promise(() => {}),
      resolveModel: async (sel) => ({ provider: sel.provider, model: sel.model }),
      prepareCall: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
        request: { endpoint: 'replay://', headers: {}, body: {} },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false },
      }),
      stream: async function* () {
        yield { type: 'done', message: { role: 'assistant', content: [] } }
      },
      providerRetryPolicy: () => ({ maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false }),
    }
    const { api } = await makeApi({ adapters: [hanging], probeTimeoutMs: 30 })
    const result = await api.probe({ provider: 'hanging' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('timeout')
      expect(result.failure.code).toBe('EN-TIMEOUT')
    }
  })
})

describe('model.getDefault / setDefault / watchDefault', () => {
  it('未配置 → undefined；setDefault 后返回扁平形（maxTokens 在顶层）', async () => {
    const { api, models } = await makeApi({ configureModel: false })
    await expect(api.getDefault()).resolves.toBeUndefined()
    const selection: ModelSelection = { provider: 'replay', model: 'replay-model', maxTokens: 8192 }
    await expect(api.setDefault({ selection })).resolves.toEqual({ saved: true })
    await expect(api.getDefault()).resolves.toEqual({ provider: 'replay', model: 'replay-model', maxTokens: 8192 })
    // 核心 service 持有的是嵌套 params 形态
    expect(models.get()).toEqual({ provider: 'replay', model: 'replay-model', params: { maxTokens: 8192 } })
  })

  it('setDefault 参数校验：缺 provider / 缺 model → EC-INVALID_PARAMS', async () => {
    const { api } = await makeApi()
    await expect(api.setDefault({ selection: { provider: '', model: 'm' } })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
    await expect(api.setDefault({ selection: { provider: 'p', model: '' } })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
  })

  it('watchDefault：可重订阅——两个独立流都收到变更', async () => {
    const { api, models } = await makeApi({ configureModel: false })
    const seenA: Array<ModelSelection | undefined> = []
    const seenB: Array<ModelSelection | undefined> = []
    const stopA = api.watchDefault().subscribe((v) => seenA.push(v))
    const stopB = api.watchDefault().subscribe((v) => seenB.push(v))
    await models.set({ provider: 'replay', model: 'm1' })
    await models.set({ provider: 'replay', model: 'm2' })
    stopA()
    stopB()
    expect(seenA.map((v) => v?.model)).toEqual(['m1', 'm2'])
    expect(seenB.map((v) => v?.model)).toEqual(['m1', 'm2'])
  })
})
