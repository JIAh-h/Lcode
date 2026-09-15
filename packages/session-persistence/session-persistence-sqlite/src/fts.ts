import type BetterSqlite3 from 'better-sqlite3'

/**
 * 中文全文检索（docs/24 §4 第 15 项采纳的方案 C）。
 *
 * **问题**：22 §3.13 指定的 `unicode61 remove_diacritics 2` 把连续汉字当成**一个** token，
 * 于是「把 parse.ts 换成结构化解析」里查「解析」「测试」「通过」命中全为 0（实测）。
 *
 * **方案**：**逐字预分词 + 前缀 AND**（零依赖，纯字符串切分）——
 * - 写入侧：`segmentForFts()` 在每个汉字的左右插空格，得到 `把 p a r s e.ts 换 成 结 构 化 解 析`
 *   这样的文本，存进 `messages_projection.fts_text`，由触发器送进 FTS；
 * - 查询侧：把查询串拆成「汉字单字」与「ASCII 词」，每个加 `*` 前缀，用 AND 连接
 *   （`解* AND 析*`），于是 1/2/3 字以上中文查询都能命中。
 *
 * 代价：每字一个 token，索引体积变大 → 需与 22 §9.2 的「索引 < 日志 15%」门禁一起验（T7.3）。
 *
 * 注意：命中展示**不用** `snippet(search_index)`（分词后中文会带空格），
 * 而是用 FTS 拿 `(session_id, seq)`，再回 `messages_projection.summary` 取原样文本。
 */

/** CJK 统一表意文字（含扩展 A 与兼容区；扩展 B 在 BMP 之外，此处不切分） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 分词：汉字逐字加空格，其余原样；空白折叠 */
export function segmentForFts(text: string): string {
  let out = ''
  for (const ch of text) {
    out += CJK.test(ch) ? ` ${ch} ` : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * 构造 FTS5 MATCH 表达式。查询为空/只有标点时返回 `''`（调用方直接返回空结果，别把空串交给 MATCH）。
 * 任何 FTS5 运算符（`"` `*` `(` `)` `-` `^` `:` 及 AND/OR/NOT 关键字）都被拆解掉，因此不会语法注入。
 */
export function buildMatchQuery(query: string): string {
  const terms: string[] = []
  const push = (term: string): void => {
    terms.push(`${term}*`)
  }
  for (const raw of query.split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '') continue
    let ascii = ''
    for (const ch of raw) {
      if (CJK.test(ch)) {
        if (ascii !== '') {
          push(ascii)
          ascii = ''
        }
        push(ch)
      } else {
        ascii += ch
      }
    }
    if (ascii !== '') push(ascii)
  }
  return terms.join(' AND ')
}

export interface SearchHit {
  readonly sessionId: string
  readonly seq: number
  readonly role: string
}

export interface SearchOptions {
  readonly limit?: number | undefined
  /**
   * 是否包含软删会话。22 未决项「软删的会话是否仍参与 FTS」倾向**不参与**
   * （避免"已删除还能搜到"），故默认排除。
   */
  readonly includeDeleted?: boolean | undefined
}

/**
 * 全文检索。返回 `(sessionId, seq, role)`——调用方按需回 `messages_projection` 取原样 `summary`。
 */
export function searchMessages(db: BetterSqlite3.Database, query: string, opts: SearchOptions = {}): SearchHit[] {
  const match = buildMatchQuery(query)
  if (match === '') return []
  const limit = opts.limit ?? 50
  const sql = `SELECT search_index.session_id AS sessionId,
                      search_index.seq        AS seq,
                      search_index.role       AS role
               FROM search_index
               JOIN sessions ON sessions.session_id = search_index.session_id
               WHERE search_index MATCH ?
                 ${opts.includeDeleted === true ? '' : 'AND sessions.deleted_at IS NULL'}
               ORDER BY rank
               LIMIT ?`
  return db.prepare(sql).all(match, limit) as SearchHit[]
}
