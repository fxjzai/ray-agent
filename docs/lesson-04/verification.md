# Lesson 04 验证记录

首次执行日期：2026-09-05（Asia/Shanghai）。Node.js `v22.22.3`；基线 `lesson-03-coding-tools`，本记录随 `lesson-04-tool-runtime` 固定保存。

发布前再次运行 `npm test`（31/31）、`npm run check` 和 `git diff --check`，均成功。以下 DeepSeek 轨迹来自首次实跑，未冒充发布前重新调用的结果。

## 自动化检查

| 命令 | 实际结果 |
|---|---|
| `npm test` | exit 0；31 tests / 31 pass / 0 fail / 0 skipped |
| `npm run check` | exit 0；CLI 和五个 Runtime 文件的语法检查通过（具体清单见 package.json） |
| `git diff --check` | exit 0 |
| `node scripts/demo-lesson-04.js` | exit 0；approve-fix 与 deny-write 均通过独立验收 |

测试分类：原四工具 13 项 + 工作区根符号链接回归 1 项 + Registry/执行器 12 项 + 审批/Loop 集成 5 项 = 31 项。

覆盖重点：参数缺失/类型/额外字段/边界值拒绝；拒绝前不产生副作用；缺审批与审批异常拒绝；After Hook 异常保留原结果；真实异步并行与返回顺序；混合批次串行；reasoning Items 和 call_id 回填；最大轮数停止。

## DeepSeek 两场景

配置：官方 `https://api.deepseek.com`，模型 `deepseek-v4-flash`。成功运行起点 UTC `2026-09-05T15:55:05.808Z`，拒绝场景起点 UTC `2026-09-05T15:55:13.731Z`。

模型请求真实发出，审批由演示脚本的受限策略决定。没有伪造人工批准。

批准场景观察到：三个 read 同批启动；第一次 npm test exit 1；edit 成功；第二次 npm test exit 0、pass 1 / fail 0。脚本另外核对文件中的加法并独立运行 npm test，exit 0。

拒绝场景观察到：write → allow=false → TOOL_DENIED → 模型解释停止。脚本核对目标文件 ENOENT、原源码不变。

完整记录见 [deepseek-trace.jsonl](deepseek-trace.jsonl)。临时副本已清理，仓库演示 fixture 无 diff。

## 真实 CLI 路径

执行 `npm start -- workspace/demo-project`，使用 PTY 发送任务：

```text
请用 write 创建 approval-cli-denied.txt，内容 hello。如果审批拒绝就停止，不重试不换工具。
```

工具展示与输入记录（略去终端控制符）：

```text
→ write  {"path":"approval-cli-denied.txt","content":"hello"}
允许本次调用？[y/N] n
审批：拒绝
← write  "TOOL_DENIED：用户拒绝本次调用，请停止该操作，不要换工具绕过审批" (112875ms)
AI: 写入操作被拒绝，我按要求停止，不再重试或改用其他工具。
你: exit
```

`n` 由本次验收代理在 PTY 输入，不是作者本人点击记录。112875ms 包含等待输入的时间，不是 write 函数执行时间。退出码 0；shell 再次确认目标文件不存在。

## 实跑中修正的问题

1. 首次演示的 edit 白名单要求完全相等的无缩进字符串，模型正常带缩进的修改被拒绝。改为只批准能把初始文件精确变成预期文件的替换。首次失败记录保存在 first-attempt.jsonl，未冒充成功轨迹。
2. macOS 临时根路径有 `/var` 和 `/private/var` 的别名。旧工具生成相对路径时没有把根规范化，返回了错误的 `../` 路径。read/write/edit 现在与路径检查使用相同的真实根；新增回归覆盖三工具。
3. 审查发现 `exitCode !== 0` 会把 undefined 误算成失败命令。验收改为要求整数非零退出码，且失败发生在成功 edit 之前。

## 尚不覆盖

未实现或验收 OS 沙箱、持久审计、并发用户会话、跨进程文件竞争、批次事务回滚或模型面对任意提示注入时的可靠性。本课的成功只证明已列明的工具执行与审批流程。
