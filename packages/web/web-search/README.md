# @lcode/web-search

网页搜索实现。

## 状态

- [x] `WebSearchBackend` 接缝 + `createWebSearcher` 规范化（provider 身份、结果条数、URL/去重）
- [x] 内置 Tavily provider（`https://api.tavily.com/search`，Bearer Key，basic 搜索）
- [x] 密钥引用 `TAVILY_API_KEY`（只进本机凭据存储）；设置页保存/测试/移除
- [x] `web_search` 工具接入：按 provider 端点申请审批，结果 snippet 按不可信内容包裹
- [ ] 第二个 provider / MCP 搜索接入（后续）
