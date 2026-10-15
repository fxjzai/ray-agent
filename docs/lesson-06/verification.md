# Lesson 06 验证记录

日期：2026-09-08（Asia/Shanghai）。Node.js v22.22.3，macOS。上一课独立提交 `d87a34ba8d0093412f41baa17f08f637339fedc4` 后工作区为空，随后新建 `codex/lesson-06-streaming`，第七篇实现没有混入上一课提交。以下为 2026-09-08 的验证记录；2026-10-16 提交前复验见文末。

## 自动化

- 原有 54 项回归测试继续通过。
- `test/streaming.test.js` 新增 23 项，23/23、0 skipped，退出码 0。
- 全部测试 77/77、0 fail、0 skipped；`npm test -- --test-reporter=dot` 实际仍显示 TAP，汇总耗时 329.771875ms，退出码 0。
- 文档同步后的最终复验：`npm test` 仍为 77/77、0 fail、0 skipped，耗时 456.335333ms；`npm run check`、差异空白检查及 fixture 无改动检查均退出码 0。23 个新增/变更文件的常见 Key 形式扫描无命中，21 个代码文档本地链接均存在；这不替代完整安全审计。
- `npm run check`：递归检查 src/test/scripts/experiments 的 39 个 JavaScript 文件，退出码 0。不检查故意失败的 workspace 项目。
- `git diff --check` 与 `git diff --exit-code -- workspace/demo-project`：退出码 0。
- `npm install --ignore-scripts`：新增 Pi TUI 0.85.1 及两个间接依赖，安装退出码 0；当次 npm audit 报告 0 vulnerabilities（不等于完整安全审计）。旧依赖版本未改。

覆盖：增量先于 final 可观察；完整 Items/reasoning 只进历史；多 message/part；final 校准不重复；incomplete/failed/意外 EOF/异常；取消及复用；参数流未完不审批；畸形响应/重复 call_id；无 CLI 的审批、Steering/FIFO、过期票号；同步/异步观察者故障；signal 监听器清理；跨 chunk 密钥脱敏；JSONL 与 UI 投影一致。

真实 Pi 组件测试覆盖中文及 emoji、20/40/80 列宽度、流更新保留未提交输入、完整审批参数可查。它是虚拟 Terminal 驱动的真实组件测试，不冒充人工屏幕截图。

两个测试使用真实 OpenAI SDK 连接本地 HTTP SSE 服务：7 字节网络分片正确解码中文/emoji；取消后服务器观察连接关闭。另有真实子进程 JSONL 双向协议测试：prompt → approval_requested → 结构化拒绝 → 完整回答 → agent_end → exit，stdin 保持打开也能退出，目标文件不存在。

## DeepSeek 实跑

命令 `node scripts/demo-lesson-06.js --live`，退出码 0。输入由脚本注入；文件工具真实执行。每个场景使用临时 fixture 副本，所有写/改/Bash 请求均未批准；结束后比对全部文件并清理临时目录。

| 场景 | 模型轮次 | 文本 delta 数 | 结果 |
|---|---:|---:|---|
| stream | 2 | 77 | read 后流式解释，completed；增量与 final 一致 |
| approval-steer | 4 | 89 | a1 在 edit 审批时失效，STEERING_SKIPPED；第 3 轮纠偏、第 4 轮追加 |
| cancel-stream | 1 | 1 | 收到“好的”后取消；message_end、turn_end、agent_end 均为 cancelled |

三个场景的 filesUnchanged、viewMatchesJsonl 均为 true。文本 delta 是事件片段数量，不是 Token 数。自动演示将事件序列化后重新投影到 UI 状态，与直接投影比较，不宣称已实现网络重连或持久化回放。

完整日志：[trace-live.jsonl](trace-live.jsonl)。起始时间分别为 UTC 03:08:36.884、03:08:39.933、03:08:53.572。

固定流独立运行 `node scripts/demo-lesson-06.js`，退出码 0；三个场景分别 2/3/1 轮、2/4/1 个 delta。[trace-fixture.jsonl](trace-fixture.jsonl) 中明确标记 fixture 和 scripted，不能把固定流的 3 轮调度与真实模型的 4 轮合成一条轨迹。

演示脚本再次运行会覆盖对应 trace 文件；若需保留多次记录，先另存旧文件。只记录公开 fixture 内容、运行事件与可见回答，配置 Key 和临时路径已净化，reasoning 不写入轨迹。

## 真实终端 smoke

在 PTY 运行 `node src/streaming.js workspace/demo-project`，助手输入：

```text
先 read src/math.js，再用三句话解释问题，不修改文件，不调用 bash。
/exit
```

真实观察到 Pi 主屏界面、read 完成、AI 文本逐段刷新、状态从“等待模型”到“正在生成”再到 completed；输入区持续显示。/exit 后退出码 0，终端恢复光标/粘贴模式控制序列。不是截图，也不是作者人工输入。

本次模型在解释中附带了未通过读取测试目录验证的“没有对应单元测试”判断；不把它当成项目事实或 Agent 调研准确性的证据。本次 smoke 只验证流式显示与退出，正文示例使用独立三场景日志。

## 一次实际发现与修复

第一轮新增测试 21/22：真实 SDK 取消会让 async iterable 正常结束，代码误抛“缺少完成事件”。已在循环结束后增加 signal 检查，再跑到 22/22；随后新增 JSONL 双向子进程测试，共 23/23。没有把第一次失败记成成功。

## 未覆盖

跨终端/Windows/复杂 IME 人工验收、长对话与慢消费者压力测试、工具 stdout 实时流、生产级脱敏、权限认证、持久化/可靠投递/断线恢复、系统沙箱、远端取消计费。当前测试证明列出的协议和生命周期边界，不证明模型答案总是准确。

## 2026-10-16 提交前复验

`npm test` 77/77、0 fail、0 skipped；`npm run check` 检查 39 个 JavaScript 文件，退出码 0。未重新实跑 DeepSeek，上面的真实模型轨迹仍是 2026-09-08 的结果。
