# 从零开发一个 Agent

这个仓库配套“Agent 开发系列”教程。它不是把每一课分别复制到不同目录，而是让同一个项目随着课程逐步成长。

当前节点：**第 0 课——调用模型并维护多轮对话历史**。

## 运行项目

```bash
npm install
cp .env.example .env
npm start
```

如果你已经有 `.env`，不要执行覆盖命令。输入 `退出`、`exit` 或 `quit` 可以结束对话。

## 本课要观察什么

- 外层 `while` 循环负责不断接收用户消息；
- `context` 数组保存用户消息和模型的完整输出；
- 模型所谓的“记忆”，来自下一次请求时重新发送的历史记录；
- 保存的是完整 `response.output`，而不只是 `response.output_text`。
