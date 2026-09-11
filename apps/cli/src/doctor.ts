import { createContext } from '@lcode/context'

/**
 * doctor：环境自检（23 §5 / §12 排障）。
 * 骨架版输出环境基本信息；模型字段的"生效值与来源层"随批次 ④（settings 六层合并）落地。
 */
export async function runDoctor(mode: 'basic' | 'model' | 'sandbox'): Promise<void> {
  const ctx = createContext()
  console.log(`Lcode doctor · Node ${process.version} · ${process.platform} ${process.arch}`)

  if (mode === 'model') {
    console.log('\n[model] 骨架阶段：六层配置解析随批次 ④ 落地')
    console.log('  生效来源将在此打印（与桌面端「设置 → 模型」一致，FR-MODEL-009）')
  }
  if (mode === 'sandbox') {
    console.log('\n[sandbox] 骨架阶段：沙箱实现随批次 ⑥ 落地')
    console.log(`  平台机制：${process.platform === 'darwin' ? 'sandbox config' : process.platform === 'linux' ? 'Landlock+seccomp' : 'AppContainer'}`)
  }

  void ctx
}
