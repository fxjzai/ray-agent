# Lesson 05：把第三篇的双层循环接起来

对应系列第六篇。发布基线为 `lesson-04-tool-runtime`（`d58d856`）；本课在 `codex/lesson-05-interaction` 单独提交保存，2026-10-16 补打发布 Tag `lesson-05-interaction`。后续课程必须从本课提交之后继续，不混入本课基线。

第三篇已经介绍 Steer / Queue / Interrupt 和双层循环图。本课落实消息的接收、消费检查点和取消链路，不重新发明术语。Steering 对应纠偏，Follow-up 是 Queue 行为中等待处理的后续消息，`abort()` 发起 Interrupt。

## 运行与对照

在仓库根目录执行，复用现有 DeepSeek `.env`。没有增加依赖或修改环境模板。

```bash
# 新的第六课 CLI；旧的 npm start 仍使用 lesson-04 入口
node src/interactive.js workspace/demo-project

# 不联网：固定 Responses 响应 + 真实文件工具/Bash
node scripts/demo-lesson-05.js

# 真实 DeepSeek 四场景，会消耗 API 用量
node scripts/demo-lesson-05.js --live

# 真实 CLI 子进程 + stdin + DeepSeek，会消耗 API 用量
node scripts/demo-cli-lesson-05.js

npm test
npm run check
```

运行中输入：

```text
/steer 先别修改，只解释原因
/follow 完成以后补一条测试建议
/approve a1 y
/cancel
/exit
```

审批同时展示模型 call_id、完整参数和本地唯一票号 `a1`。必须用当前票号明确回答 y/yes 或 n/no；普通 y 不会批准。插话使等待中的审批失效；追加任务不影响审批。错误/过期票号不能批准其他调用。空闲普通文本启动任务，忙时普通文本被提示改用明确命令。

EOF、/exit 取消当前任务并等待收尾；Ctrl+C 在 busy 时取消、idle 时退出。本课没有逐 Token 流输出，模型完成一轮后显示完整文本。

## 跟着代码读：只增加这一层

1. [responses-turn.js](../../src/runtime/responses-turn.js)：模型请求边界，signal 放在 SDK 请求选项。拒绝 incomplete/failed、空输出和重复 call_id，不执行残缺调用。完整 output Items 原样保留，包括 reasoning；UI 只接收文本与事件。
2. [session.js](../../src/runtime/session.js)：外层消费 Follow-up，内层处理模型/工具/Steering。消息由输入入口持续入队，在模型请求前及未启动的工具边界生效。
3. [tool-executor.js](../../src/runtime/tool-executor.js)：复用上一课 Registry、Ajv、Before/After Hook 和批次策略；可选执行上下文增加 signal、shouldSkip、onToolEvent。旧调用方式不变。
4. [interactive-input.js](../../src/runtime/interactive-input.js)：同一个输入分发器处理聊天、排队、审批和取消，不再通过多个 rl.question 争抢 stdin。
5. [bash.js](../../src/tools/bash.js)：可选第三参数传 signal，取消时终止任务进程组、等待 close、清理监听器和计时器。
6. [interactive.js](../../src/interactive.js)：组装依赖并监听 readline。收尾后 pause/unref stdin，避免父进程保持管道打开时 CLI 无法退出。

### 会话接口与边界

```javascript
const session = createAgentSession({ runTurn, executor, onEvent, maxTurns: 8 });
const done = session.prompt("检查项目");
session.steer("先别修改，只解释原因");
session.followUp("完成后补测试说明");
await done; // { status, turns, text, error? }
```

- `prompt` 在同一进程中保留历史；busy 时拒绝重复 prompt。历史 getter 返回副本，退出程序不持久化。
- Steering 在一个边界按 FIFO 消费当前全部消息；Follow-up 在当前任务无工具且无 Steering 后每次消费一条。
- 每轮模型输出先全部保留，所有已声明调用补齐 `function_call_output`，再加入 Steering。未启动的调用回填 `STEERING_SKIPPED` / `CANCELLED`。
- 整批都是无审批的 parallel 工具时仍并行，否则整批串行。已启动工具不能因插话而撤回；忽略 signal 的工具仍等待真实结果。
- 最大轮数包括当前任务和 Follow-up；cancelled/error/max_turns 收尾清空尚未消费的队列，agent_end 报告 discarded 数量。
- 这是 Responses 专用历史；只把 UI 事件与供应商 Items 分开，尚不是通用跨供应商 AgentMessage 层。
- 观察接口是同步回调，异常隔离、事件快照、不承诺等待异步观察者。事件是进程内通知，不是持久审计日志。

事件包含 sequence、agent_start/end、turn_start/end、queued、message（用户输入消费）、answer、tool_start/end/skipped、cancel_requested。工具结果事件不等于模型原始 Items；终端不输出模型 reasoning。

## 取消能保证什么

- 模型：本地 HTTP/SDK 请求接收取消；不能据此保证远端推理或计费停止。
- 审批：释放等待 Promise，票号失效，调用不启动。
- 文件工具：在启动前检查；进行中的读写不保证中断，也不回滚已完成修改。
- Bash：macOS/Linux 普通任务进程组收到 SIGKILL，等待 close 后返回 `cancelled: true`。主动脱离进程组的子进程不在保证内，Windows 未验证。这不是系统沙箱。
- 保留实际输出、exitCode 和 signal；“请求取消”和“操作未发生”不能混用。

## 演示证据

2026-09-07 真实运行记录：

| 证据 | 模型 | 工具/输入 | 验收 |
|---|---|---|---|
| [trace-fixture.jsonl](trace-fixture.jsonl) | 固定 Responses fixture | 真实 read/Bash，脚本输入与受限审批 | 四场景通过，已有 edit 调用被跳过，文件不变 |
| [trace-live.jsonl](trace-live.jsonl) | DeepSeek v4 Flash | 真实工具，脚本输入与受限审批 | 三轮纠偏/追加、审批取消、Bash 取消、请求取消均通过 |
| [trace-cli.txt](trace-cli.txt) | DeepSeek v4 Flash | 真实 CLI 子进程的 stdin，由父进程注入 | 插话先于追加，读文件但不修改，/exit 正常退出 |

真实 DeepSeek 的 steering 场景第一轮只提出 read，没有提出 edit，所以该轨迹没有 STEERING_SKIPPED；跳过行为由 fixture 场景单独验证。真实工具演示为便于稳定注入，刻意把 read 的返回延迟 100ms，日志标记 demo_gate。真实 CLI 演示没有这一延迟。

真实模型三轮摘录（完整内容见轨迹）：

```text
read src/math.js
先排入 /follow，再排入 /steer
第二轮：好的，不做任何修改。仅说明问题……
第三轮：补充一句测试建议……
verification: completed；turns=3；filesUnchanged=true
```

四场景脚本复制 fixture 到临时目录，对比全部文件并清理副本。Bash 场景确认命令真实启动，并以独立进程组探测检查无遗留。演示会覆盖同名轨迹文件；不要把脚本输出当成人工截图。

## 验证与一次实际发现的退出问题

命令、实际退出码与测试汇总见 [验证记录](verification.md)。

`test/interaction.test.js` 新增 15 项测试，加上上一课 31 项和早期原型 8 项，共 54 项。覆盖：

- reasoning 与 call_id 配对、串/并行和跳过结果；
- 插话/追加 FIFO、任务结束边界、预算和重入；
- 不完整回复、模型错误、持续历史、观察者隔离；
- 审批拒绝、错票号、过期票号、插话撤销审批、取消与 EOF；
- signal 传到真实 SDK HTTP 连接、Bash 子孙进程退出、取消监听器清理；
- 输入管道仍打开时 /exit 正常退出。

第一次真实 CLI 演示中，消息顺序正确，但 /exit 后进程未退出：readline 关闭后，父进程保持打开的 stdin 管道仍保活。修复是在等待任务收尾后 pause/unref stdin，并新增“不发送 EOF”的回归测试。修复后重新运行真实 CLI 演示。

`npm run check` 仍是上一课的检查列表；新文件另用 `node --check` 检查，发布前再决定是否切换默认入口与根脚本。

## 保留的早期原型

[experiments/lesson-05/session.js](../../experiments/lesson-05/session.js) 和 [demo.js](../../experiments/lesson-05/demo.js) 仅用于展示最初的调度推导：模拟模型、模拟工具、每次 prompt 清空历史、串行工具。它们不再是本课实际入口；不要把其简化消息格式混入正式 Responses 历史。

## 交接与发布边界

- 文章已完成一轮审稿并补入真实 VS Code 截图（助手操控输入，不是作者手动输入或日志回放）。截图主场景独立于上面的自动脚本：审批等待时先 Follow-up 后 Steering，共四轮，edit 回填 STEERING_SKIPPED；另有 sleep 60 取消截图。演示 fixture 未改动。
- 2026-09-08 在开始 lesson-06 前重新验证并单独提交本课。未推送或打 Tag；不要用上一课 Tag 声称已包含新入口。
- 不宣称“Pi 完整内核一致”：尚无通用消息转换、上下文压缩、持久化历史、系统沙箱或逐 Token 流。

参考：[DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)、[Pi Agent Loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)。Pi 源码明确分内层工具/Steering 与外层 Follow-up；本课仅借鉴调度结构。
