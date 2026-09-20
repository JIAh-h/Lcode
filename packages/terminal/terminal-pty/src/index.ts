export type { LocalTerminalOptions } from './local-terminal.ts'
export { createLocalTerminal, LocalTerminalService } from './local-terminal.ts'

/** 供能力装配层调用的最小注册入口。 */
export function register(): () => void {
  return () => {}
}
