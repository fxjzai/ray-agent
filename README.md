# 从零开发一个 Agent

这个仓库配套“Agent 开发系列”教程。它不是把每一课分别复制到不同目录，而是让同一个项目随着课程逐步成长。

课程正文、蓝图与网站开发位于 [`fxjzai/build-agents-from-scratch`](https://github.com/fxjzai/build-agents-from-scratch)，本仓库只保存可运行代码和每一课对应的 Git Tag。

当前发布节点：**第 4 课（系列第五篇）——Tool Registry、参数校验、执行策略和审批 Hook**，对应 `lesson-04-tool-runtime`。

[阅读第五篇正式文章](https://mp.weixin.qq.com/s/UTwpxPMDwDGYKz2U7rdKDA)。

第六篇（lesson-05）的独立提交见 [双层循环、交互输入与演示证据](docs/lesson-05/README.md)。入口为 `node src/interactive.js workspace/demo-project`，已接入 DeepSeek、插话/追加、审批分发与取消；尚未发布 Tag。`npm start` 仍保留 lesson-04 CLI。

## 运行项目

```bash
npm install
cp .env.example .env
npm start
```

在 `.env` 中填写 DeepSeek 官方 API Key。项目通过 OpenAI JavaScript SDK 调用 DeepSeek Responses API，默认入口为 `https://api.deepseek.com`，模型为 `deepseek-v4-flash`。

如果你已经有 `.env`，不要执行覆盖命令。输入 `退出`、`exit` 或 `quit` 可以结束对话。

默认工作区是启动命令所在目录，也可以把第一个参数指向单独的工作区：

```bash
npm start -- workspace/demo-project
```

## 课程节点

| Tag | 内容 |
|---|---|
| `lesson-00-chat` | 调用模型并维护多轮对话历史 |
| `lesson-01-function-call` | 定义天气工具并完成一次工具调用 |
| `lesson-02-agent-loop` | 增加内层工具循环、并行调用和停止条件 |
| `lesson-03-coding-tools` | `read/write/edit/bash` 四工具与工作区路径约束 |
| `lesson-04-tool-runtime` | 工具注册、参数校验、串并行策略、Hook 与逐次审批 |

第 4 课的逐步代码说明、测试结果与演示见 [lesson-04 教程](docs/lesson-04/README.md)。

切换到某一课：

```bash
git switch --detach lesson-00-chat
```

回到最新代码：

```bash
git switch main
```

## 当前开发节点要观察什么

- `read` 按行读取文件，并通过 `offset` 和 `limit` 控制进入上下文的内容；
- `write` 创建或完整覆盖文件，`edit` 只替换唯一的精确匹配；
- `bash` 在指定工作区中执行命令，返回输出、退出码和超时状态；
- 文件工具拒绝访问工作区之外的路径，但 Bash 的工作目录限制不是安全沙箱；
- Registry 统一工具定义、实现和本地执行策略，Ajv 在调用前校验参数；
- 全批次都是无需审批的 `parallel` 工具时并行，否则整批按调用顺序串行；
- `read` 自动执行，`write/edit/bash` 每次展示完整参数，输入 `y` 或 `yes` 才批准；
- 拒绝、参数错误、执行异常都回填模型，After Hook 记录结果与耗时。

仓库包含一个故意写错加法逻辑的演示项目。可以运行 Agent 后输入：

```text
阅读这个项目，找出测试失败的原因，修复代码并运行测试验证。
```

测试使用 Node.js 内置测试运行器；运行时参数校验依赖 Ajv。单元测试无需 API Key：

```bash
npm test
npm run check
```

两条真实 DeepSeek 演示（需要有效 Key，会产生 API 用量）：

```bash
npm run demo:04
```

演示在临时副本中运行，审批由脚本中的受限策略作出；正常 CLI 使用逐次终端审批。审批只控制是否启动调用，不限制批准后的 Bash 对文件、网络和凭证的访问。本课未实现系统沙箱或持久审计日志。
