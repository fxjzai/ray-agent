# Lesson 06：流式事件、结构化控制与简单终端

对应系列第七篇。上一课已独立提交为 `d87a34ba8d0093412f41baa17f08f637339fedc4`，本课在 `codex/lesson-06-streaming` 开发，2026-10-16 提交并发布为 `lesson-06-streaming`（上一课补打 `lesson-05-interaction`）。没有改动上一课提交或已发布 Tag。

目标：继续使用自己的 Agent 循环；参考 Pi 的分层，只引入 `@earendil-works/pi-tui@0.85.1` 做三块终端布局。重点是运行时可被其他应用观察和控制，不是完整 Coding CLI。

## 运行

要求 Node.js ≥22.19.0（本次使用 22.22.3）；复用已有 DeepSeek `.env`，不要覆盖。首次安装需要 npm 网络或已有缓存；源稿、本文、测试和 fixture 演示均已在本地，可断网阅读/运行。

```bash
npm install --ignore-scripts
npm test
npm run check

# 真实终端：Pi TUI 主屏模式，保留终端滚动历史
npm run start:06 -- workspace/demo-project

# 程序对接：stdin 每行结构化命令，stdout 每行事件
node src/streaming.js --jsonl workspace/demo-project

# 固定模型流 + 真实文件工具，不联网
npm run demo:06

# DeepSeek 三场景；消耗 API 用量，输入由脚本注入
npm run demo:06 -- --live
```

`npm start` 仍是 lesson-04 入口；`node src/interactive.js` 保留 lesson-05 非流式 CLI。当前共享模块已向前演进，若要精确复现上一课源码，应查看 `d87a34b` 提交，而不是用当前工作区冒充旧版本。

交互终端支持普通任务、`/steer 内容`、`/follow 内容`、`/approve a1 y|n`、`/cancel`、`/exit`。Ctrl+C：运行中请求取消，空闲时退出；Ctrl+D：取消并退出。终端只显示纯文本、工具摘要、完整审批参数、状态和输入，不做 Markdown 富排版、多面板或工具 stdout 实时流。

## 按代码变化逐步学习

### 1. 给请求适配层加一条流式路径

[responses-turn.js](../../src/runtime/responses-turn.js) 增加 `stream` 开关，默认 false 保持旧入口。新入口显式开启。

[responses-stream.js](../../src/runtime/responses-stream.js) 消费 SDK 的 async iterable：

- `response.output_item.added` 的 message 开始一条回答；文本 delta 按 output/content 索引归并。
- 对外只发 `message_start`、`text_delta`、`message_end`；reasoning 与工具参数片段不输出到 UI/JSONL。
- `response.completed` 中的完整 response 交给 [responses-output.js](../../src/runtime/responses-output.js) 校验，完整 Items 才返回给会话。
- final 文本是权威快照，界面用它校准同一条消息，不二次追加全文。
- incomplete/failed、异常、没有终结事件的 EOF 都不采用本轮 output，不执行其中工具。已显示的片段以未完成状态结束。
- SDK 取消可能正常结束迭代，所以循环结束后还要 `signal.throwIfAborted()`，区分取消与意外截断。

已有历史仍是 Responses Items；没有新增通用跨供应商消息层。增量片段不等于 Token。

### 2. 扩展会话事件，但不改变双层循环规则

[session.js](../../src/runtime/session.js) 为一次 prompt 分配 `runId`，事件序号在该运行内从 1 递增；为消息加运行内唯一 ID。流式路径不再发送旧的全文 `answer` 事件，非流式路径仍保留。

工具仍然等整轮模型响应完成后才校验、审批和执行。Steering 仍在原来的检查点被消费；输入实时接收不表示新要求能进入已经发出的模型请求。

### 3. 审批从输入模块中拿出来

[approval-broker.js](../../src/runtime/approval-broker.js) 管理待审批 Promise、票号和 signal 监听器。它不依赖 stdin，不打印文字。

- 执行器通过 `session.requestApproval(event)` 请求审批。
- 外部通过 `session.approve({approvalId, allow})` 作出决定，allow 必须是 boolean。
- `session.steer()` 先排入纠偏，再在运行时撤销待审批票；不依赖任何 UI 观察者。
- 拒绝回填 TOOL_DENIED；插话撤销由执行器回填 STEERING_SKIPPED；取消回填 CANCELLED。
- 票号在同一 session 生命周期中不复用，过期/重复票号报错。

[agent-controller.js](../../src/runtime/agent-controller.js) 接收结构化命令。`dispatch(prompt)` 立即返回接收确认，任务在后台推进；`wait()` 用来等待当前任务。旧的 `interactive-input.js` 只用于 lesson-05 对照入口，新入口不依赖它。

### 4. 一个出口，两个消费者

[streaming.js](../../src/streaming.js) 负责组装 SDK、Registry、执行器、session、controller 和输出端。默认 DeepSeek 官方 origin；不增加环境变量；请求 60 秒超时、不自动重试、最多 8 个模型轮次。

- [terminal-command.js](../../src/ui/terminal-command.js)：终端字符串 → 结构化控制命令。
- [public-events.js](../../src/ui/public-events.js)：对已配置 Key 脱敏（含跨 chunk 前缀）、移除终端控制字符。仅是出口净化，不是通用数据分级系统。
- [view-state.js](../../src/ui/view-state.js)：纯状态投影，同一组事件可以测试或从 JSONL 重新投影。
- [tui.js](../../src/ui/tui.js)：只使用 Pi 的 Container/Text/Input/TuiMainScreen；模型更新不重建输入组件。20/40/80 列中文布局有定向测试。
- [jsonl.js](../../src/ui/jsonl.js)：每行一个 JSON 事件，不夹杂启动提示、审批问句和 ANSI。命令错误走 stderr。

TUI 与 JSONL 不各写一套 Agent。stdout 或 stdin 不是 TTY 时自动选 JSONL；因此管道输入必须是 JSON 命令，不是普通聊天文本。

## JSONL 控制示例

先启动进程，保持 stdin 打开。下面是独立命令示例，不是应当一次性全部发送的脚本：

```json
{"type":"prompt","content":"读取 src/math.js，解释问题，不修改。"}
{"type":"steer","content":"只解释，不调用工具。"}
{"type":"follow_up","content":"完成后补一句测试建议。"}
{"type":"approve","approvalId":"a1","allow":false}
{"type":"cancel"}
{"type":"exit"}
```

批准前先读取真实 `approval_requested` 中的票号和完整参数，不能假设总是 a1。普通 y 或字符串 "true" 不能批准。

**EOF 的语义是取消并退出**，不是“停止输入但等待任务自然完成”。不要用 `echo prompt | ...` 来做一次性任务；应由父进程读事件，收到 agent_end 后发送 exit，再关闭管道。自动化测试包含这一双向交互。

本地 `dispatch()` 有接收确认；JSONL 目前只输出运行事件，命令解析错误写 stderr，没有 RPC request/ack 协议、身份认证或多会话路由。`exit` 正常关闭返回进程码 0；任务是否完成看 `agent_end.status`，不要只看进程码。

## 验收与边界

[事件约定](events.md) · [验证记录](verification.md) · [固定流轨迹](trace-fixture.jsonl) · [DeepSeek 轨迹](trace-live.jsonl)

本课 23 项新测试，连同原 54 项共 77 项。真实 DeepSeek 三场景分别观察到 77/89/1 个文本 delta；这些是片段数量，不是 Token 统计。审批场景真实模型用了 4 轮，固定流用了 3 轮，不混合成一条轨迹。

以下未实现：工具输出实时流、持久化/断线恢复/可靠投递、跨供应商消息格式、完整 Web 服务、ACP/MCP、多 Agent、操作系统沙箱。慢输出消费者的背压、长对话内存上限也尚未做生产级治理。跨进程/多租户接入前，还需增加路由、权限与敏感信息过滤。

文件操作与 Bash 继续使用前课边界：审批不是沙箱；已发生的副作用不回滚；HTTP 取消不证明远端推理/计费停止。对外事件含工具结果和用户文本，不可直接开放给不受信任客户端。观察回调是同步通知，异常隔离且不等待异步订阅者，不作为审批或持久化屏障。

参考：[DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)、[Pi Agent](https://github.com/earendil-works/pi/tree/main/packages/agent)、[Pi TUI](https://github.com/earendil-works/pi/tree/main/packages/tui)。实际使用的 TUI 版本和完整性摘要固定在 package-lock.json；没有复制或替换 Pi Agent 内核。
