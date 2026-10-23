/**
 * 请求构建前的附件解析口。
 *
 * 内核只知道"引用 → base64"这一件事；文件放在哪、如何校验由宿主实现。
 * 未注册（CLI/测试）时 `image-ref` 会退化成一句缺失说明，而不是让整轮请求失败。
 */
export interface AttachmentResolver {
  resolveImage(input: { readonly hash: string; readonly mediaType: string }): Promise<string | undefined> | string | undefined
}

declare module '@lcode/context' {
  interface Services {
    attachments: AttachmentResolver
  }
}
