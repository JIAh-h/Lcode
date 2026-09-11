import { ApprovalModal } from '../components/ui.tsx'

/** P4 询问弹窗（19 §3.4）：拒绝与取消是两个不同的事实，不合并。 */
export function AskApprovalPage() {
  return (
    <ApprovalModal
      action="写入 /Users/you/other-project/.env"
      basis="它想改动这个项目之外的文件"
      impact="工作区外写入，需要你确认"
      onResult={() => window.history.back()}
    />
  )
}
