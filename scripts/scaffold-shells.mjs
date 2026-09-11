// 一次性脚手架：生成实现壳包（骨架占位，后续批次填充）。
// 用法：node scripts/scaffold-shells.mjs   （生成后可删除本脚本）
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const TS_BASE = `{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib" },
  "include": ["src"]
}
`

function pkg(pkgName, { desc, dir, deps = [], readme }) {
  return { pkgName, desc, dir, deps, readme }
}

const SHELLS = [
  // fs 族
  pkg('fs-local', { desc: '本机文件系统实现（批次⑤）', dir: 'fs/fs-local', deps: ['@lcode/fs', '@lcode/context', '@lcode/util'] }),
  pkg('fs-sandbox', { desc: '受沙箱约束的文件系统实现', dir: 'fs/fs-sandbox', deps: ['@lcode/fs', '@lcode/sandbox', '@lcode/context'] }),
  pkg('tool-fs', { desc: '文件工具消费包：read/write/edit/glob/grep（21 §3.1-3.5）', dir: 'fs/tool-fs', deps: ['@lcode/fs', '@lcode/tools', '@lcode/context'] }),
  // shell 族
  pkg('shell-local', { desc: '本机 shell 实现（批次⑤）', dir: 'shell/shell-local', deps: ['@lcode/shell', '@lcode/subprocess', '@lcode/context'] }),
  pkg('shell-sandbox', { desc: '受沙箱约束的 shell 实现', dir: 'shell/shell-sandbox', deps: ['@lcode/shell', '@lcode/sandbox', '@lcode/context'] }),
  pkg('tool-shell', { desc: 'shell 工具消费包（21 §3.6）', dir: 'shell/tool-shell', deps: ['@lcode/shell', '@lcode/tools', '@lcode/context'] }),
  // terminal / subprocess
  pkg('terminal-pty', { desc: 'PTY 终端实现', dir: 'terminal/terminal-pty', deps: ['@lcode/terminal', '@lcode/subprocess', '@lcode/context'] }),
  pkg('tool-terminal', { desc: '终端工具消费包（21 §3.7）', dir: 'terminal/tool-terminal', deps: ['@lcode/terminal', '@lcode/tools', '@lcode/context'] }),
  pkg('subprocess-local', { desc: '本机子进程实现（进程树可整体终止）', dir: 'subprocess/subprocess-local', deps: ['@lcode/subprocess', '@lcode/context'] }),
  // sandbox 平台实现
  pkg('sandbox-macos', { desc: 'macOS 沙箱（sandbox config，darwin only）', dir: 'sandbox/sandbox-macos', deps: ['@lcode/sandbox', '@lcode/context'] }),
  pkg('sandbox-linux', { desc: 'Linux 沙箱（Landlock + seccomp）', dir: 'sandbox/sandbox-linux', deps: ['@lcode/sandbox', '@lcode/context'] }),
  pkg('sandbox-win32', { desc: 'Windows 沙箱（AppContainer + Job Object）', dir: 'sandbox/sandbox-win32', deps: ['@lcode/sandbox', '@lcode/context'] }),
  // settings / credentials
  pkg('settings-file', { desc: 'settings.json 落盘实现', dir: 'settings/settings-file', deps: ['@lcode/settings', '@lcode/context'] }),
  pkg('credentials-local', { desc: 'env/.env/keychain 凭据解析（D22）', dir: 'credentials/credentials-local', deps: ['@lcode/credentials', '@lcode/context'] }),
  // llm 适配器
  pkg('llm-anthropic', { desc: 'Anthropic 适配器', dir: 'llm/llm-anthropic', deps: ['@lcode/llm', '@lcode/settings', '@lcode/credentials', '@lcode/context'] }),
  pkg('llm-openai', { desc: 'OpenAI 适配器', dir: 'llm/llm-openai', deps: ['@lcode/llm', '@lcode/settings', '@lcode/credentials', '@lcode/context'] }),
  pkg('llm-deepseek', { desc: 'DeepSeek 适配器（批次④首个真实适配器）', dir: 'llm/llm-deepseek', deps: ['@lcode/llm', '@lcode/settings', '@lcode/credentials', '@lcode/context'] }),
  pkg('llm-ollama', { desc: 'Ollama 本地模型适配器', dir: 'llm/llm-ollama', deps: ['@lcode/llm', '@lcode/settings', '@lcode/context'] }),
  pkg('llm-gateway', { desc: '统一网关适配器', dir: 'llm/llm-gateway', deps: ['@lcode/llm', '@lcode/settings', '@lcode/context'] }),
  // compaction / spill
  pkg('compaction-prune', { desc: '压缩-剪枝（轻量先行）', dir: 'compaction/compaction-prune', deps: ['@lcode/compaction', '@lcode/session', '@lcode/context'] }),
  pkg('compaction-summary', { desc: '压缩-摘要（最后手段）', dir: 'compaction/compaction-summary', deps: ['@lcode/compaction', '@lcode/session', '@lcode/context'] }),
  pkg('spill-local', { desc: '超大工具结果落盘 + locator（溢出存储）', dir: 'compaction/spill-local', deps: ['@lcode/util', '@lcode/session', '@lcode/context'] }),
  // skill / subagent / jobs
  pkg('skill-filesystem', { desc: '技能两段式加载实现', dir: 'skill/skill-filesystem', deps: ['@lcode/skill', '@lcode/context'] }),
  pkg('tool-skill', { desc: '技能工具消费包', dir: 'skill/tool-skill', deps: ['@lcode/skill', '@lcode/tools', '@lcode/context'] }),
  pkg('subagent-inprocess', { desc: '子代理进程内实现（能力只可收窄）', dir: 'subagent/subagent-inprocess', deps: ['@lcode/subagent', '@lcode/tools', '@lcode/context'] }),
  pkg('tool-subagent', { desc: '子代理工具消费包', dir: 'subagent/tool-subagent', deps: ['@lcode/subagent', '@lcode/tools', '@lcode/context'] }),
  pkg('jobs-local', { desc: '后台作业本地实现（输出有界缓冲）', dir: 'jobs/jobs-local', deps: ['@lcode/jobs', '@lcode/subprocess', '@lcode/context'] }),
  pkg('tool-jobs', { desc: '作业工具消费包', dir: 'jobs/tool-jobs', deps: ['@lcode/jobs', '@lcode/tools', '@lcode/context'] }),
  // web / lsp
  pkg('web-fetch', { desc: '网页抓取实现（内容包裹转义，12 §8）', dir: 'web/web-fetch', deps: ['@lcode/web', '@lcode/context'] }),
  pkg('web-search', { desc: '网页搜索实现', dir: 'web/web-search', deps: ['@lcode/web', '@lcode/context'] }),
  pkg('tool-web', { desc: '网页工具消费包（web_fetch/web_search，21 §3.9）', dir: 'web/tool-web', deps: ['@lcode/web', '@lcode/tools', '@lcode/context'] }),
  pkg('lsp-stdio', { desc: 'LSP stdio 实现', dir: 'lsp/lsp-stdio', deps: ['@lcode/lsp', '@lcode/subprocess', '@lcode/context'] }),
  pkg('tool-lsp', { desc: 'LSP 工具消费包', dir: 'lsp/tool-lsp', deps: ['@lcode/lsp', '@lcode/tools', '@lcode/context'] }),
  // interaction 消费包
  pkg('permission-presets', { desc: '权限预设（两条权限轴）', dir: 'interaction/permission-presets', deps: ['@lcode/approval', '@lcode/context'] }),
  pkg('user-questions', { desc: '用户提问（ask_user）接口包', dir: 'interaction/user-questions', deps: ['@lcode/context', '@lcode/util'] }),
  pkg('commands', { desc: '斜杠命令接口包', dir: 'interaction/commands', deps: ['@lcode/context', '@lcode/util'] }),
  pkg('tool-ask-user', { desc: 'ask_user 工具消费包（21 §3.10）', dir: 'interaction/tool-ask-user', deps: ['@lcode/tools', '@lcode/context'] }),
  pkg('tool-todo', { desc: 'todo_write 工具消费包（21 §3.8）', dir: 'interaction/tool-todo', deps: ['@lcode/tools', '@lcode/session', '@lcode/context'] }),
  pkg('plan-mode', { desc: '计划模式（plan/mode 事件）', dir: 'interaction/plan-mode', deps: ['@lcode/session', '@lcode/context'] }),
  // context 族（注册到 systemPrompt.context()）
  pkg('context-instructions', { desc: '指令上下文', dir: 'context/context-instructions', deps: ['@lcode/system-prompt', '@lcode/context'] }),
  pkg('context-time', { desc: '时间上下文', dir: 'context/context-time', deps: ['@lcode/system-prompt', '@lcode/context'] }),
  pkg('context-repo-map', { desc: '仓库地图上下文', dir: 'context/context-repo-map', deps: ['@lcode/system-prompt', '@lcode/context'] }),
  pkg('file-reference', { desc: '文件引用上下文', dir: 'context/file-reference', deps: ['@lcode/system-prompt', '@lcode/context'] }),
  pkg('session-reference', { desc: '会话引用上下文', dir: 'context/session-reference', deps: ['@lcode/system-prompt', '@lcode/context'] }),
  // extension / preset / bundle
  pkg('plugin-host', { desc: '插件宿主（独立 utility process，类型化 RPC）', dir: 'extension/plugin-host', deps: ['@lcode/context', '@lcode/plugin-manifest'] }),
  pkg('plugin-registry', { desc: '插件注册表', dir: 'extension/plugin-registry', deps: ['@lcode/plugin-manifest', '@lcode/context'] }),
  pkg('plugin-sdk', { desc: '插件 SDK（apply/ctx/type-rpc）', dir: 'extension/plugin-sdk', deps: ['@lcode/context', '@lcode/plugin-manifest'] }),
  pkg('agent-presets', { desc: '预设装配实现', dir: 'preset/agent-presets', deps: ['@lcode/preset', '@lcode/context'] }),
  pkg('lcode-base', { desc: '基础集束（仅装配声明，无逻辑代码）', dir: 'bundle/lcode-base', deps: [] }),
  pkg('lcode-desktop', { desc: '桌面集束（仅装配声明，无逻辑代码）', dir: 'bundle/lcode-desktop', deps: [] }),
]

let count = 0
for (const s of SHELLS) {
  const dir = join(ROOT, 'packages', s.dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  const pkgJson = {
    name: `@lcode/${s.pkgName}`,
    version: '0.1.0',
    description: s.desc,
    type: 'module',
    private: true,
    exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
    dependencies: Object.fromEntries([...s.deps, '@lcode/util'].map((d) => [d, 'workspace:*'])),
    scripts: { build: 'tsc -p tsconfig.json --noEmit' },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n')
  writeFileSync(join(dir, 'tsconfig.json'), TS_BASE)
  writeFileSync(
    join(dir, 'README.md'),
    `# @lcode/${s.pkgName}\n\n> 实现/消费壳包（骨架占位）。${s.desc}。\n\n## 状态\n\n- [ ] 待实现（按文档 23 §14 批次推进）\n`,
  )
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `/**
 * @lcode/${s.pkgName} —— 骨架占位壳。
 * ${s.desc}
 * 真实实现按文档 23 §14 批次推进；当前导出空注册占位。
 */
export function register(): () => void {
  return () => {}
}
`,
  )
  count++
}
console.log(`generated ${count} shell packages`)
