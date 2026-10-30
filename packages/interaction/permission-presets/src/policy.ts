import { canonicalPath, isInsideWorkspace } from '@lcode/fs'
import type { ApprovalBasis, ApprovalPathImpact, Impact } from '@lcode/session'
import type { SandboxMode } from '@lcode/sandbox'
import { resolve } from 'node:path'
import { knobsOf } from './permission-presets.ts'
import type { PermissionPreset } from './permission-presets.ts'

/**
 * 权限判定：**什么动作需要审批**（12 §6 / §9.3；批次⑥）。
 *
 * ## 它在流水线的哪一步
 *
 * `tools/pre-execute` 的 waterfall（12 §6.4 的顺序）：
 *
 * ```
 * ① 参数校验 → ② pre-execute（**这里是本模块**）→ ③ 需要则 approval.ask
 *            → ④ 单调 guard（只能 deny）→ ⑤ 执行
 * ```
 *
 * **③ 在 ④ 之前**是硬要求（14 §3.5）：先问人、后过红线。反过来会让"用户批准了"
 * 变成绕过守卫的通行证——那正是审批**不能**用来替代守卫的原因。
 *
 * ## 判定的三条原则
 *
 * - **默认宽松、越界严格**：工作区内的读写不问（否则一次重构要确认几十次，
 *   用户会开始无脑点允许，那比不问更危险）；越界一律问。
 * - **`never` 档直接拒绝**（不是放行）：见 `permission-presets.ts` 的说明。
 * - **路径判定只有一处**：用 `@lcode/fs` 的 `isInsideWorkspace`，
 *   实现层不得各自再写一份（20 §6.1）。
 */

/** 一个工具调用被提取出的"动作意图"（由工具自己申报，策略据此判断） */
export interface ActionIntent {
  readonly tool: string
  /** 一句话摘要（给用户看，不是 JSON dump） */
  readonly summary: string
  /** 涉及的文件路径（**未解析的相对或绝对**；由策略解析并判定边界） */
  readonly paths?: readonly { readonly path: string; readonly mode: 'read' | 'write' }[] | undefined
  /** 要执行的命令 argv（shell 族） */
  readonly argv?: readonly string[] | undefined
  /** 出站域名（web 族） */
  readonly domains?: readonly string[] | undefined
  /** web 工具请求的完整 URL（审批展示用；不影响域名判定） */
  readonly url?: string | undefined
  /** 命令需要访问网络（shell/终端族）：OS 沙箱按本次调用或终端会话放开网络。 */
  readonly network?: boolean | undefined
  readonly networkScope?: 'call' | 'terminal' | undefined
  /** 涉及的环境变量**名**（只给名字不给值，I7） */
  readonly env?: readonly string[] | undefined
  /** 请求的沙箱档位（放宽档位本身要审批，12 §9.3 ⑤） */
  readonly requestedSandboxMode?: SandboxMode | undefined
}

/** 判定的结论 */
export type Verdict =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny'
      readonly code: 'EP-DENIED_BY_GUARD' | 'EP-OUTSIDE_WORKSPACE' | 'EP-APPROVAL_UNAVAILABLE'
      readonly reason: string
    }
  | { readonly kind: 'ask'; readonly basis: ApprovalBasis; readonly impact: Impact }

export interface PolicyContext {
  readonly preset: PermissionPreset
  readonly workspaceRoot: string
  /** "项目已见命令集"（启发式，12 §9.3）：未出现过的命令会触发审批 */
  readonly seenCommands?: ReadonlySet<string> | undefined
  /** 项目已知域名（启发式） */
  readonly seenDomains?: ReadonlySet<string> | undefined
  /** 这是子代理发起的调用吗（子代理**不能直接问人**，12 §5.6） */
  readonly delegated?: boolean | undefined
}

/** 疑似凭据的路径（12 §9.3 ④） */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_ed25519$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)credentials(\..+)?$/i,
]

/** 破坏性命令（12 §2.3 T2：始终二次确认） */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[df]/i,
  /\b(mkfs|dd)\b.*\bof=/i,
  /\bchmod\s+-R\s+777\b/i,
  />\s*\/dev\/(sd|nvme)/i,
]

/** 审批触发类别：`auto` 策略按它决定哪些触发保留审批 */
type ReasonKind = 'outside-write' | 'credential' | 'dangerous' | 'new-command' | 'new-domain' | 'network' | 'sandbox-widen'

/**
 * `auto` 策略下仍保留审批的触发：不可逆破坏 + 数据外发。
 * 越界写 / 新命令 / 放宽沙箱属于“边界类”，在「完全访问」下自动放行。
 */
const AUTO_APPROVAL_KINDS: ReadonlySet<ReasonKind> = new Set(['dangerous', 'credential', 'new-domain', 'network'])

/**
 * 判定一个动作（12 §9.3 的六类高风险动作，逐条对应）。
 *
 * 返回 `ask` 时附带**三段齐备**的 basis 与 impact——那直接进审批弹窗，
 * 所以 `outsideWorkspace` 与 `domains` 必须如实填（UI 靠它们显著标出，T1 最后防线）。
 */
export function evaluate(intent: ActionIntent, ctx: PolicyContext): Verdict {
  const { approvalPolicy } = knobsOf(ctx.preset)
  /*
   * **工作区根也要规范化解析**，不能拿调用方给的原样字符串去比。
   *
   * 因为 `resolve(root, p.path)` 会把两边都变成绝对路径，而 `isInsideWorkspace` 是
   * **字符串前缀**比较：一边有盘符、一边没有（Windows 上 `resolve('/repo/web','a')`
   * 会得到 `D:/repo/web/a`），比出来永远是"在外面"——于是工作区内的普通写也被要求审批。
   *
   * 实测踩过：Windows 上所有工作区内写入都会弹窗。
   */
  /*
   * **真实路径**：工作区内一个指向外部的 symlink 不能因为字符串前缀“看起来在工作区”
   * 就通过边界判定。目标不存在时 canonicalPath 会取最近存在祖先的真实路径。
   */
  const workspaceRoot = canonicalPath(ctx.workspaceRoot)

  // ── 先把"要不要问"算出来（与档位无关，档位只决定 ask 还是 deny / auto 还是兜底）──
  const reasons: { kind: ReasonKind; basis: ApprovalBasis; impact: Impact }[] = []

  // ① 写工作区**之外**的路径（12 §9.3 ①）
  const pathImpacts: ApprovalPathImpact[] = []
  for (const p of intent.paths ?? []) {
    const abs = canonicalPath(resolve(workspaceRoot, p.path))
    pathImpacts.push({ path: abs, mode: p.mode, outsideWorkspace: !isInsideWorkspace(workspaceRoot, abs) })
  }
  const outsideWrites = pathImpacts.filter((p) => p.mode === 'write' && p.outsideWorkspace)
  if (outsideWrites.length > 0) {
    reasons.push({
      kind: 'outside-write',
      basis: { source: 'preset', reason: '要改动工作区之外的文件', presetName: ctx.preset },
      // ⚠️ outsideWorkspace 一定带上：UI 必须显著标出（21 §6.2 / EP-OUTSIDE_WORKSPACE）
      impact: { paths: outsideWrites },
    })
  }

  // ④ 读取疑似凭据（12 §9.3 ④）
  const credentialReads = pathImpacts.filter((p) => p.mode === 'read' && matchesAny(p.path, CREDENTIAL_PATTERNS))
  if (credentialReads.length > 0) {
    reasons.push({
      kind: 'credential',
      basis: { source: 'preset', reason: '要读取疑似存放凭据的文件', presetName: ctx.preset },
      impact: { paths: credentialReads },
    })
  }

  // ③ 执行"项目中从未出现过"的命令（12 §9.3 ③；启发式，不是安全保证）
  if (intent.argv !== undefined && intent.argv.length > 0) {
    const head = commandKey(intent.argv)
    const isNew = ctx.seenCommands !== undefined && !ctx.seenCommands.has(head)
    const isDangerous = matchesAny(intent.argv.join(' '), DANGEROUS_PATTERNS)
    if (isDangerous) {
      reasons.push({
        kind: 'dangerous',
        basis: { source: 'preset', reason: '这是一条破坏性命令', presetName: ctx.preset },
        impact: { processScope: intent.summary },
      })
    } else if (isNew) {
      reasons.push({
        kind: 'new-command',
        basis: { source: 'preset', reason: '这个命令在项目里还没出现过', presetName: ctx.preset },
        impact: { processScope: intent.summary },
      })
    }
  }

  // ② 网络出站到"项目未出现过"的域名（12 §9.3 ②）
  const newDomains = (intent.domains ?? []).filter((d) => ctx.seenDomains === undefined || !ctx.seenDomains.has(d))
  if (newDomains.length > 0) {
    reasons.push({
      kind: 'new-domain',
      basis: { source: 'preset', reason: '要把数据发到这个站点', presetName: ctx.preset },
      impact: {
        network: {
          domains: newDomains,
          ...(intent.url === undefined ? {} : { url: intent.url }),
        },
      },
    })
  }
  // shell 显式要求联网：即使没有具体域名也必须在本次调用上问一次。
  if (intent.network === true) {
    reasons.push({
      kind: 'network',
      basis: { source: 'preset', reason: '这条命令要访问网络', presetName: ctx.preset },
      impact: {
        network: {
          domains: ['*'],
          ...(intent.networkScope === undefined ? {} : { scope: intent.networkScope }),
        },
      },
    })
  }

  // ⑤ 放宽沙箱档位（12 §9.3 ⑤）
  const { sandboxMode } = knobsOf(ctx.preset)
  if (intent.requestedSandboxMode !== undefined && rank(intent.requestedSandboxMode) > rank(sandboxMode)) {
    reasons.push({
      kind: 'sandbox-widen',
      basis: { source: 'preset', reason: '要放宽沙箱限制', presetName: ctx.preset },
      impact: { sandboxChange: { from: sandboxMode, to: intent.requestedSandboxMode } },
    })
  }

  // ── `read-only` 档：任何写都是拒绝（不是"问"）──
  //
  // 只读是用户明确表达的"别改我的东西"，问一下就能改会让这一档名存实亡。
  if (sandboxMode === 'read-only') {
    const writes = pathImpacts.filter((p) => p.mode === 'write')
    if (writes.length > 0) {
      return { kind: 'deny', code: 'EP-OUTSIDE_WORKSPACE', reason: '当前是「只读」预设，不能改动任何文件' }
    }
    // 只读不开放网络出站：否则“只看”可以被用来把工作区内容发出去。
    if (intent.network === true || (intent.domains?.length ?? 0) > 0) {
      return { kind: 'deny', code: 'EP-DENIED_BY_GUARD', reason: '当前是「只读」预设，不开放网络访问' }
    }
  }

  // ── 没有命中任何高风险动作：放行（工作区内读写不问，这是「标准」的手感）──
  // ── `auto` 档（「完全访问」）：边界类动作不问，只留兜底审批 ──
  //
  // 这档本来就没有工作区边界可言，越界写/新命令/放宽沙箱再问一次只是在制造噪音；
  // 但不可逆破坏与数据外发（读凭据、出站新域名、显式联网）仍然要过人类确认。
  const effective = approvalPolicy === 'auto'
    ? reasons.filter((reason) => AUTO_APPROVAL_KINDS.has(reason.kind))
    : reasons
  if (effective.length === 0) return { kind: 'allow' }

  // 合并所有命中理由（一次问清，而不是连着弹三个框）
  const merged = mergeReasons(effective)

  /*
   * 环境变量名是**信息**，不是触发条件（12 §5.4）。
   *
   * 它挂在 impact 上让用户在审批卡上看到"这条命令会拿到 OPENAI_API_KEY"，
   * 但它本身不构成"要问"的理由——`PATH`、`NODE_ENV` 这类天天都在用，
   * 拿它当触发条件会让每一条命令都弹窗。
   *
   * **只有名字，没有值**（I7）：类型上 `env` 就是 `string[]`，
   * 值根本没有进入这个数据的通道——这是类型层面的落实，不是靠"记得别填值"。
   */
  if (intent.env !== undefined && intent.env.length > 0 && merged.impact.env === undefined) {
    merged.impact = { ...merged.impact, env: intent.env }
  }

  /*
   * `never` 档：**直接拒绝，不是放行**（12 §3.3）。
   *
   * 这是全局最容易读错的一格。“自动审批”的语义是"别打扰我"，
   * 那意味着遇到高风险动作时**按最保守的方式处理**（拒掉），而不是"那都随你"。
   */
  if (approvalPolicy === 'never') {
    return {
      kind: 'deny',
      code: 'EP-DENIED_BY_GUARD',
      // 理由要说清"为什么没人问你就被拒了"，否则用户会以为是 bug
      reason: `当前预设（${ctx.preset}）不询问，已按最保守方式拒绝：${merged.basis.reason}`,
    }
  }

  /*
   * 子代理**不能直接问人**（12 §5.6）。
   *
   * 它不能在这里落成 `ask`：那会弹出一个"不知道是谁在问"的框，而人批了之后
   * 也没法追溯授权链。所以落成**拒绝**，错误码用 `EP-APPROVAL_UNAVAILABLE`
   * ——语义是"这次审批不可用"（fail-closed），而不是"被守卫拒了"。
   */
  if (ctx.delegated === true) {
    return {
      kind: 'deny',
      code: 'EP-APPROVAL_UNAVAILABLE',
      reason: '子代理不能直接请求审批，已按 fail-closed 拒绝',
    }
  }

  return { kind: 'ask', basis: merged.basis, impact: merged.impact }
}

// ─────────── 内部 ───────────

function rank(mode: SandboxMode): number {
  return mode === 'read-only' ? 0 : mode === 'workspace-write' ? 1 : 2
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text))
}

/** 命令的"身份"：可执行文件 + 第一个子命令（`git push` 与 `git log` 是两条不同命令） */
function commandKey(argv: readonly string[]): string {
  const head = argv[0] ?? ''
  const sub = argv[1] !== undefined && !argv[1].startsWith('-') ? ` ${argv[1]}` : ''
  return `${basename(head)}${sub}`
}

function basename(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return at < 0 ? p : p.slice(at + 1)
}

/** 把多条理由合成一条（一次问清；弹三个框会让人不再细看） */
function mergeReasons(reasons: readonly { basis: ApprovalBasis; impact: Impact }[]): {
  basis: ApprovalBasis
  impact: Impact
} {
  const first = reasons[0]
  if (first === undefined) throw new Error('mergeReasons 至少需要一条理由')
  if (reasons.length === 1) return first

  const paths = reasons.flatMap((r) => r.impact.paths ?? [])
  const domains = reasons.flatMap((r) => r.impact.network?.domains ?? [])
  const url = reasons.find((r) => r.impact.network?.url !== undefined)?.impact.network?.url
  const networkScope = reasons.find((r) => r.impact.network?.scope !== undefined)?.impact.network?.scope
  const env = reasons.flatMap((r) => r.impact.env ?? [])
  return {
    // 理由用"；"接起来——用户看到的是一句话，而不是三个 bullet
    basis: { ...first.basis, reason: reasons.map((r) => r.basis.reason).join('；') },
    impact: {
      ...(paths.length === 0 ? {} : { paths }),
      ...(domains.length === 0 ? {} : {
        network: {
          domains,
          ...(url === undefined ? {} : { url }),
          ...(networkScope === undefined ? {} : { scope: networkScope }),
        },
      }),
      ...(env.length === 0 ? {} : { env }),
      ...(first.impact.processScope === undefined ? {} : { processScope: first.impact.processScope }),
      ...(first.impact.sandboxChange === undefined ? {} : { sandboxChange: first.impact.sandboxChange }),
    },
  }
}
