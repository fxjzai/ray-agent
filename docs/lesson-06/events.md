# Lesson 06 最小事件与控制约定

本课本地进程接口，尚不是稳定的网络协议或审计日志。供应商的原始 SSE 事件只在 Responses 适配层解释，不直接对外透传。

## 公共字段

| 字段 | 含义 |
|---|---|
| type | 事件类型 |
| runId | 每次 prompt 新建 UUID，同一运行中的 Follow-up 共用此 ID |
| sequence | 同一 runId 内从 1 严格递增，由会话统一分配，不沿用供应商序号 |
| turn | 事件发生时已启动的最近模型轮次；首次请求前是 0 |
| messageId | 消息事件的关联 ID，接收方视为不透明字符串，不解析它的格式 |
| callId | 工具与审批事件关联原始模型调用；工具事件暂保留旧 call_id 别名 |
| approvalId | 一次待审批请求的票号，同一 session 生命周期不复用 |

`queued`/`message` 的 turn 不是“模型已经看到这条输入”的证明。输入可能在两轮之间加入历史，只有下一次请求才会携带它。runId 区分运行，不实现用户认证；approvalId 只在绑定的 session 中查找。

## 事件

| 事件 | 关键内容 / 语义 |
|---|---|
| agent_start | 一次任务运行开始 |
| queued | kind=steer/follow_up，content；输入已排队 |
| message | kind=prompt/steer/follow_up，content；用户输入进入历史，沿用第六篇名称 |
| turn_start | 一次模型轮次开始，包括等待模型阶段 |
| message_start | messageId、role=assistant；开始一条可见回答 |
| text_delta | messageId、partIndex、delta；仅追加到该内容块 |
| message_end | messageId、text、status；text 替换/校准已有显示，不再次追加 |
| approval_requested | approvalId、callId、name、完整 args；等待显式决定 |
| approval_resolved | approvalId、callId、outcome、reason；票号此时已失效 |
| tool_start | callId、name、args；执行器准备启动并再次检查取消/插话边界 |
| tool_end / tool_skipped | callId、name、result、durationMs；按实际结果回填，耗时包含审批等待 |
| turn_end | status；模型及本批工具已处理，或本轮异常/取消 |
| cancel_requested | 发出取消请求，不代表底层操作全部结束 |
| agent_end | status、turns、discarded、可选 error；当前运行收尾完成 |

非流式旧入口另有 `answer{text}`，新流式入口只使用消息生命周期，不能把 message_end 再打印成一份回答。

### 状态

- message_end：completed / incomplete / error / cancelled。incomplete 指供应商截断；异常 EOF 为 error。没有收到可见 message 时不会虚构一个空回答。
- turn_end：completed / error / cancelled。一轮 completed 不等于整个任务完成，也不代表其中每个工具都成功。
- agent_end：completed / error / cancelled / max_turns。消息可能已经完整生成，而任务在后续工具阶段取消，两者并不矛盾。
- approval_resolved.outcome：approved / rejected / invalidated。只有 approved 能放行；失效原因包括插话、取消、任务结束。

## 正常流与异常流

```text
turn_start
  message_start
  text_delta × N
  message_end(completed)   ← 完整模型响应已校验；不是整个任务结束
  [工具校验 → approval_requested → 外部 approve → tool_start/end]
turn_end
[下一轮模型请求或 Follow-up]
agent_end
```

```text
message_start → text_delta → cancel_requested
  → message_end(cancelled) → turn_end(cancelled) → agent_end(cancelled)
```

实际可能只有工具调用，没有可见文本；或包含多个 message/part。不要假设每轮只有一条回答，也不要把 function_call 参数片段当成 text_delta。

## 消费规则

1. 按 messageId 和 partIndex 追加增量，按 partIndex 排序拼显示；message_end.text 是整条消息权威快照。
2. 未完成消息留在 UI 并标状态，不作为完整响应进入模型历史；不执行残缺调用。
3. 使用审批请求中的完整参数作决定。`session.approve({approvalId,allow})` 是操作，事件订阅不隐式批准。
4. `session.steer()` 会主动使待审批票失效，即使没有任何事件消费者；Follow-up 不会抢走审批。
5. 移除控制字符和已配置密钥后再渲染/导出。密钥跨 chunk 的尾部前缀可能暂缓显示，message_end 再校准；不能要求净化后的增量始终等于原始供应商文本。
6. 序号只用于进程内排序/诊断；JSONL 不是持久化恢复承诺。日志、业务结果与模型历史各有职责。

## 对接方式

`createAgentController(session).dispatch(command)` 接受 prompt/steer/follow_up/approve/cancel/exit。prompt 不阻塞后续命令接收；`wait()` 等当前运行。错误命令同步抛错。

入口的 JSONL 模式由 readline 持续接收对象，调用同一 dispatch。EOF/exit 取消当前运行并等待收尾；没有内建自动批准。TUI 只是把斜杠命令解析为这些对象。
