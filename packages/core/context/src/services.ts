/**
 * 服务与事件的声明合并宿主（文档 20 §4.2）。
 * 接口包通过 `declare module '@lcode/context'` 增补：
 *
 *   declare module '@lcode/context' {
 *     interface Services { fs: FsService }
 *     interface Events   { 'fs/changed': { path: string } }
 *   }
 *
 * 两个接口都是**开放**的（声明合并），内核消费方按字符串键访问，
 * 因此内部用宽松类型，编译期类型安全由各接口包的声明合并保证。
 */

/** 全部已注册服务的键值映射（开放，声明合并扩展） */
export interface Services {}

/** 全部已声明事件的名称 → payload 映射（开放，声明合并扩展） */
export interface Events {}

/** ctx key 的"一个 / 多个"语义：单数 = 一个引擎；复数 = 注册表（文档 00 §5.1） */
export type ServiceKey = keyof Services & string

export type EventName = keyof Events & string
