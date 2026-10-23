/**
 * `@lcode/lcode-desktop` —— 桌面集束（**装配层**）。
 *
 * 这里是"把实现包拼到一起"的地方：接口包不得依赖实现包（20 §3），
 * 所以 `model-api` 这类边界层需要的能力必须由**集束**注入。
 *
 * 目前承载：
 * - `createDesktopModelFeature()`：模型配置的全套装配（`ctx.llm` + settings + credentials
 *   → 可用的 `model.*`）。桌面主进程经 IPC 薄转发到它。
 */

export { createAgentRuntime } from './agent-runtime.ts'
export type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.ts'
export { buildUserContent } from './user-content.ts'
export type { ImageAttachmentWriter, SkillSource, UserContentInput } from './user-content.ts'
export { attachmentRefsOf, gcAttachments, putAttachment, readAttachment } from '@lcode/session-api'
export { gcSessionAttachments } from './attachment-gc.ts'
export { importSkill, removeUserSkill, seedBuiltinSkills } from './skill-import.ts'
export type { ImportedSkill } from './skill-import.ts'

export { createDesktopModelFeature, createServices, ensureNativePackageRoot } from './model-feature.ts'
export type {
  CreateServicesOptions,
  DesktopModelFeature,
  DesktopModelFeatureOptions,
  DesktopServices,
} from './model-feature.ts'
