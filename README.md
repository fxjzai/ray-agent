# 从零开发一个 Agent

这个仓库配套“Agent 开发系列”教程。它不是把每一课分别复制到不同目录，而是让同一个项目随着课程逐步成长。

课程正文、蓝图与网站开发位于 [`fxjzai/build-agents-from-scratch`](https://github.com/fxjzai/build-agents-from-scratch)，本仓库只保存可运行代码和每一课对应的 Git Tag。

当前开发节点：**第 3 课——为 Agent 增加 `read`、`write`、`edit` 和 `bash` 四个基础工具**。

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
- 同一轮多个工具调用暂时串行执行，避免写文件和命令执行发生副作用冲突；
- 显式 `switch` 路由仍然保留，下一课再引入 Tool Registry、权限、审批和 Hook。

仓库包含一个故意写错加法逻辑的演示项目。可以运行 Agent 后输入：

```text
阅读这个项目，找出测试失败的原因，修复代码并运行测试验证。
```

工具测试使用 Node.js 内置测试运行器，不需要额外依赖：

```bash
node --test test/tools.test.js
```
