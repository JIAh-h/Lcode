export interface EmbeddingConfig {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string | undefined
}

export interface EmbeddingClientOptions {
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
}

/** 常见配置里用户会直接粘 `/chat/completions`；embeddings 换同一前缀，避免 404。 */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/embeddings')) return trimmed
  if (trimmed.endsWith('/chat/completions')) return `${trimmed.slice(0, -'/chat/completions'.length)}/embeddings`
  return `${trimmed}/embeddings`
}

/**
 * 调 OpenAI 兼容的 `POST /embeddings`。一次一批，返回与输入等长的向量。
 * 错误信息只带状态码与响应片段，绝不回显 Authorization（I7）。
 */
export async function embedTexts(
  config: EmbeddingConfig,
  texts: readonly string[],
  signal: AbortSignal,
  options: EmbeddingClientOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return []
  const doFetch = options.fetch ?? globalThis.fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey !== undefined && config.apiKey !== '') headers['authorization'] = `Bearer ${config.apiKey}`
  let res: Response
  try {
    res = await doFetch(embeddingsUrl(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: [...texts], encoding_format: 'float' }),
      signal: AbortSignal.any([signal, timeout]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`Embedding 请求失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`Embedding 接口返回 HTTP ${res.status}${detail === '' ? '' : `：${detail}`}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error('Embedding 接口返回的不是 JSON')
  }
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`Embedding 返回条数不对（期望 ${texts.length}，实际 ${Array.isArray(data) ? data.length : 0}）`)
  }
  const vectors: number[][] = []
  for (const item of data) {
    const embedding = typeof item === 'object' && item !== null ? (item as { embedding?: unknown }).embedding : undefined
    if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('Embedding 返回了空向量')
    const vector: number[] = []
    for (const value of embedding) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Embedding 向量包含非数值')
      vector.push(value)
    }
    vectors.push(vector)
  }
  const dim = vectors[0]?.length ?? 0
  for (const vector of vectors) {
    if (vector.length !== dim) throw new Error('Embedding 向量维度不一致')
  }
  return vectors
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

export function vectorToBlob(vector: readonly number[]): Buffer {
  const floats = Float32Array.from(vector)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}

export function blobToVector(blob: Uint8Array): Float32Array {
  // SQLite 返回的 Buffer 可能带 byteOffset，必须按实际区间取
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}
