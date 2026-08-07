# 从零开发一个 Agent

这个仓库配套“Agent 开发系列”教程。它不是把每一课分别复制到不同目录，而是让同一个项目随着课程逐步成长。

当前节点：**第 1 课——让模型完成一次 Function Call**。

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

切换到某一课：

```bash
git switch --detach lesson-00-chat
```

回到最新代码：

```bash
git switch main
```

## 本课要观察什么

- `weatherTool` 是给模型看的工具说明；
- `getWeather` 是应用真正执行的 JavaScript 函数；
- 模型只会返回 `function_call`，不会替应用执行天气查询；
- 应用执行工具后，要用相同的 `call_id` 回传 `function_call_output`；
- 当前版本只处理一次工具调用，下一课再把固定的两次模型请求改成循环。

可以输入：

```text
帮我查一下深圳现在的天气。
```
