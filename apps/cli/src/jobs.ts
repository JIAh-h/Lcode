/**
 * CLI 的后台作业入口。
 *
 * 作业属于启动它的桌面/CLI 运行时；当前没有跨进程守护服务，因此一个新开的 CLI
 * 不能读取或终止另一个进程的内存资源。这里把这个事实做成稳定命令，而不是伪造空
 * 结果或声称已经恢复。
 */
const USAGE = `lcode jobs — 活动作业

  lcode jobs list
  lcode jobs status <job-id>
  lcode jobs read <job-id>
  lcode jobs kill <job-id>`

export async function runJobsCommand(argv: readonly string[]): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  if (!['list', 'status', 'read', 'kill'].includes(command)) {
    console.error(`未知 jobs 命令：${command}`)
    console.log(USAGE)
    return 1
  }
  console.error(
    '没有可附着的活动作业：后台作业只驻留于启动它的桌面或 CLI 进程，' +
      '当前 CLI 不会跨进程恢复或接管它们。请在原桌面会话的“任务”面板中查看或停止作业。',
  )
  return command === 'list' ? 0 : 1
}
