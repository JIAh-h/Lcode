# @lcode/plugin-registry

本地插件安装注册表（P6-02）。`LocalPluginRegistry.install()` 只接受本地目录：复制到 staging 快照，
拒绝符号链接，校验 `lcode.json`、`package.json` 的 ESM 声明、入口和 `engines.lcode`，再将 SHA-256
记录写入 SQLite 的 `plugins` 表。

安装产物位于 `<LCODE_HOME>/plugins/<id>/<version>/`，状态始终为 `installed`。本包不会 `import()`
插件入口、不会启动子进程，也不提供 activate；这些能力属于后续 P6-03/P6-04。
