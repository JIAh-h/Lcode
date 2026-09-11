/**
 * CLI 入口（文档 20 §7.2 / 23 §5）。
 * 骨架版：命令分发 + doctor 占位；真实装配随批次 ⑦。
 */
import { runDoctor } from './doctor.ts'

export interface CliOptions {
  readonly profile?: string
  readonly dumpConfig?: boolean
  readonly doctor?: 'basic' | 'model' | 'sandbox'
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--profile':
        opts.profile = argv[++i]
        break
      case '--dump-config':
        opts.dumpConfig = true
        break
      case 'doctor':
        opts.doctor = 'basic'
        break
      case '--model':
        opts.doctor = 'model'
        break
      case '--sandbox':
        opts.doctor = 'sandbox'
        break
      default:
        break
    }
  }
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.doctor) {
    await runDoctor(opts.doctor)
    return
  }
  if (opts.dumpConfig) {
    // TODO(批次⑦)：打印最终插件装配（含层级与来源）
    console.log(JSON.stringify({ profile: opts.profile ?? 'default', bundles: [] }, null, 2))
    return
  }
  console.log('Lcode CLI（骨架）— 可用命令：lcode doctor [--model|--sandbox] | lcode --dump-config [--profile <name>]')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
