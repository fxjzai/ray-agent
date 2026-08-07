# 从零开发一个 Agent

这个仓库配套“Agent 开发系列”教程。它不是把每一课分别复制到不同目录，而是让同一个项目随着课程逐步成长。

当前节点：**第 2 课——让 Agent 循环调用工具直到任务完成**。

## 运行项目

```bash
npm install
cp .env.example .env
npm start
```

如果你已经有 `.env`，不要执行覆盖命令。输入 `退出`、`exit` 或 `quit` 可以结束对话。

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

## 本课要观察什么

- 外层 `while` 循环持续接收用户消息，负责多轮对话；
- 内层 `for` 循环持续处理“模型 → 工具 → 模型”，负责完成当前任务；
- `filter` 会收集模型同一轮返回的全部 Tool Call；
- 天气查询没有副作用，可以使用 `Promise.all` 并行执行；
- 工具错误会作为结构化结果回传，而不是直接终止整个 Agent；
- `maxTurns` 是防止无限工具循环的最后保护线。

可以输入：

```text
先查深圳现在的天气，如果正在下雨就查北京，不下雨就查上海。
```

也可以观察同一轮的多个并行调用：

```text
比较北京、上海、广州和深圳现在的天气。
```

下一课将在这个版本上增加 `read`、`write`、`edit` 和 `bash` 等基础工具。
