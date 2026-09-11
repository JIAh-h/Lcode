/**
 * 签名元素：常驻时间轴脊柱（文档 19 §1.4 / UX-VISUAL-002）。
 * 把"可倒带"做进界面骨架——工作台右侧的垂直时间轴，每个节点 = 一个检查点（turn 边界），
 * 点击进入回放（P3）。
 */
export interface TimelineNode {
  readonly seq: number
  readonly label: string
  readonly kind: 'turn' | 'step' | 'compaction' | 'recovery'
}

export function TimelineSpine({
  nodes,
  activeSeq,
  onSelect,
}: {
  nodes: readonly TimelineNode[]
  activeSeq?: number | undefined
  onSelect?: ((node: TimelineNode) => void) | undefined
}) {
  return (
    <div className="spine" aria-label="时间轴">
      <div className="spine-head">时间轴</div>
      <div className="spine-track">
        {nodes.map((node) => (
          <button
            key={node.seq}
            className={`spine-node kind-${node.kind}${node.seq === activeSeq ? ' active' : ''}`}
            onClick={() => onSelect?.(node)}
            title={node.label}
          >
            <i />
            <span>{node.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
