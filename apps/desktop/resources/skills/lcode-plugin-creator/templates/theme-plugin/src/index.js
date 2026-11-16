/**
 * 换肤插件的 **host** 入口。
 *
 * 这个文件跑在独立的 utility process（Node 环境），能申请文件/网络权限。
 * 换肤本身不需要 host 能力，但 manifest 里声明了 `activation.events`，
 * 所以宿主仍会实例化它。
 *
 * 留着这个文件是刻意的：它演示"一个插件可以同时有 host 与 client 两半"。
 * 只想改界面的插件可以把 host 这一半写成空的。
 */

export async function activate() {
  // 换肤不需要 host 侧逻辑；这里保持空实现，等宿主把配置交给 client 那一半。
}
