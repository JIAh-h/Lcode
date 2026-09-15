import { ApprovalDialog } from '../components/ApprovalDialog.tsx'

/**
 * P4 审批页（19 §3.4）。
 *
 * 从**演示入口**变成了真实接线的落点：这个页面挂的是 `ApprovalDialog`，
 * 它订阅内核的 `approval/asked` 推送（走 `lcode:approval.asked`）。
 *
 * 为什么保留这个路由（而不是只在外壳里挂一个全局弹窗）：审批有时是用户
 * **主动走过去**看的——比如他从侧栏点"待确认"，或者从通知里跳过来。
 * 全局弹窗负责"突然弹出来"的那条路，这个页面负责"我自己来看"的那条。
 */
export function AskApprovalPage() {
  return (
    <div className="ask-page">
      <ApprovalDialog />
    </div>
  )
}
