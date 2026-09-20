export type { ToolTerminalDeps } from './tools.ts'
export { createTerminalTool } from './tools.ts'

export function register(): () => void {
  return () => {}
}
