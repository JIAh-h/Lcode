/** 技能目录条目（常驻，只含名字与描述，不加载全文） */
export interface SkillCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** SkillService —— 两段式加载：catalog 常驻，命中才 load 全文 */
export interface SkillService {
  catalog(): Promise<readonly SkillCatalogEntry[]>
  load(id: string): Promise<{ readonly instructions: string; readonly path: string } | undefined>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    skills: SkillService
  }
}
