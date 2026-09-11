/** WebService —— 网页抓取/搜索（抓回内容必须包裹并转义，12 §8 提示注入防线） */
export interface WebService {
  fetch(url: string, opts?: { readonly signal?: AbortSignal }): Promise<{ readonly url: string; readonly content: string }>
  search(query: string, opts?: { readonly limit?: number }): Promise<readonly { readonly title: string; readonly url: string }[]>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    web: WebService
  }
}
