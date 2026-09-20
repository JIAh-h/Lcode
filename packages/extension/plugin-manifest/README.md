# @lcode/plugin-manifest

扩展层的 `lcode.json` 严格解析器（文档 13 §3.5）。只支持
`https://lcode.dev/schema/plugin-1.json`；未知字段、越界 ESM entry、非法 semver 和非法权限形状均返回
`EX-MANIFEST_INVALID`。

省略 `permissions` 时规范化为零权限。P6-02 只校验和记录清单；运行时贡献与权限授予由 P6-03/P6-04 处理。
