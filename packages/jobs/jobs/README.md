# @lcode/jobs

> 能力层接口包（文档 20 §6.1「作业」族，`ctx.jobs`）。
> 作业输出**有界缓冲**；超出转 spill。实现：`jobs-local`；消费：`tool-jobs` + 后台 shell/终端。
