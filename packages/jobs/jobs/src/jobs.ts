export interface JobHandle {
  readonly id: string
  readonly status: 'running' | 'done' | 'killed'
  kill(): Promise<void>
}

/** JobsService —— 后台作业（输出有界缓冲） */
export interface JobsService {
  start(input: { readonly kind: string; readonly command: string }): Promise<JobHandle>
  get(id: string): JobHandle | undefined
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    jobs: JobsService
  }
}
