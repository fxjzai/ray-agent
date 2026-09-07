# Lesson 04：可控的工具执行层

对应系列第五篇。基线为 `lesson-03-coding-tools`，本课固定版本为 [`lesson-04-tool-runtime`](https://github.com/fxjzai/ray-agent/tree/lesson-04-tool-runtime)。

[公众号正式文章](https://mp.weixin.qq.com/s/UTwpxPMDwDGYKz2U7rdKDA)。

## 先运行

```bash
npm install
npm test
npm run check
npm start -- workspace/demo-project
```

CLI 沿用现有 `.env` 中的 DeepSeek 配置。`read` 不询问；`write/edit/bash` 每次展示完整 JSON 参数后询问 `允许本次调用？[y/N]`，只有 `y/yes` 放行。回车或其他输入拒绝。按 `exit` 退出对话。

## 按这个顺序阅读代码

1. [tool-registry.js](../../src/runtime/tool-registry.js)：用 Map 保存 definition、execute、executionMode、requiresApproval；注册时编译 Schema，重复名称立即报错。
2. [coding-tools.js](../../src/runtime/coding-tools.js)：四个旧工具只在这里组装。read 明确允许并行且无需审批；其余沿用“串行、需审批”默认值。
3. [tool-executor.js](../../src/runtime/tool-executor.js)：查找、JSON 解析、Ajv 校验、Before Hook、执行、After Hook、Responses 结果组装。
4. [approval.js](../../src/runtime/approval.js)：把终端交互注入 Hook。执行器不用依赖 readline，演示也可以注入确定的审批策略。
5. [agent-loop.js](../../src/runtime/agent-loop.js)：保留历史 Items 和轮数预算，工具批次交给 executeToolCalls。
6. [agent.js](../../src/agent.js)：连接 DeepSeek、工作区、Registry、审批和终端输入。

这是从第四篇继续修改同一份项目，不需要重写 read/write/edit/bash，也没有加载第三方插件。

## 本课的执行约定

```text
模型 function_call
  → Registry 查找
  → JSON.parse + Ajv 校验
  → Before Hook / 审批
  → execute(args, workspaceRoot)
  → After Hook 记录结果和耗时
  → function_call_output 回填模型
```

错误路径跳过执行函数，仍到 After Hook 和结果回填。成功结果保留上一课的字段；错误格式为 `{error: {code, message}}`。

| 错误码 | 含义 |
|---|---|
| UNKNOWN_TOOL | 没有注册该工具 |
| INVALID_JSON | arguments 不是合法 JSON |
| INVALID_ARGUMENTS | 不符合工具的 JSON Schema |
| TOOL_DENIED | 审批拒绝、缺少明确批准或 Before Hook 异常 |
| TOOL_EXECUTION_FAILED | 工具执行或返回值序列化失败 |

`bash` 的非零退出码仍是正常的工具观察结果；测试失败不等于执行器异常。

| 批次 | 调度 |
|---|---|
| read + read | 并行；结果数组按请求顺序回填 |
| read + edit + bash | 全部串行；每个有副作用的调用逐次审批 |
| parallel 但需要审批 | 串行；避免同时出现多个问题 |
| 含未知工具 | 串行；未知调用返回错误 |

串行不分析依赖，也不提供事务：前面的调用被拒绝，后续调用仍逐个检查自己的审批。提示词要求模型尊重拒绝；最终能否启动另一个调用仍由该次审批决定。

Before Hook 的参数是 `{toolCall, args, tool, workspaceRoot}`。需审批工具只有 `{allow: true}` 能执行；无需审批工具允许 Hook 返回 undefined，但显式拒绝和 Hook 抛错仍阻止执行。

After Hook 额外接收 `result` 与 `durationMs`；耗时包含解析、校验、等待审批和执行，不含 After Hook 自身。日志异常不会覆盖已经完成的执行结果，避免模型误以为没写成功而重试。

## 真实演示与证据

```bash
npm run demo:04
```

演示使用真实 DeepSeek Responses API、真实文件工具和真实 `npm test`。每次复制 fixture 到临时目录，完成后清理副本。默认模型 `deepseek-v4-flash`，脚本核验官方 API origin，并限制每次请求 60 秒、最多 8 轮、不自动重试。

演示脚本注入的是 `scripted-policy`，不是人工点击记录。批准场景只允许 `npm test`（或 `npm test 2>&1`）和把源码变成预期加法的 edit；拒绝场景阻止所有需审批操作。

任务提示指定了读取路径、修复目标和命令，因此验证的是执行层端到端行为，不是模型自主排查未知项目的能力。模型真实生成参数，脚本真实执行工具，最后独立检查产物。

- [完整成功运行 JSONL](deepseek-trace.jsonl)：两个场景，含完整参数、call_id、结果、模型回答和独立验收。
- [首次运行片段](first-attempt.jsonl)：修复动作因行首缩进不满足旧白名单而拒绝；片段从第一个 call 开始，保留失败验收。
- [测试与演示结果](verification.md)：命令、数量、人工终端路径和边界。

2026-09-05 成功轨迹摘要（按实际记录顺序，省略完整内容）：

```text
→ read src/math.js
→ read test/math.test.js
→ read package.json
← read package.json        8 行
← read test/math.test.js   7 行
← read src/math.js         3 行
→ bash npm test            策略批准 → exitCode=1，-1 !== 5
→ edit src/math.js         策略批准 → 已替换唯一匹配项
→ bash npm test            策略批准 → exitCode=0，pass 1 / fail 0
独立验收：源码已修复；再次 npm test，exitCode=0

→ write approval-denied.txt
审批：策略拒绝
← TOOL_DENIED
模型：审批被拒绝，文件未创建。
独立验收：文件不存在，原源码未变
```

三个 read 都先出现 call，然后出现 result，实际完成顺序与请求顺序相反。返回数组仍保持请求顺序；对应单元测试用同步屏障验证，没有靠毫秒阈值猜测并行。

日志已把临时工作区替换为 `<workspace>`，隐藏已配置密钥。只记录这个公开演示 fixture 的内容；请勿把该记录方式直接用于含敏感数据的工作区。

## 本课边界

Registry 和 Hook 是受信任的本地程序代码，不是隔离第三方插件的安全边界。Schema 检查形状与类型，不判断 `command` 的业务安全性。

审批决定“这一次能否开始”；操作系统沙箱决定“开始后能够碰到哪些资源”。本课只有前者。read 自动执行也不表示读取内容可以公开；Bash 获批后继承进程环境，可以访问工作区外和网络。终端 Hook 只是观察接口，不是可恢复、防篡改的持久审计系统。

正常 CLI 使用真实文件，演示脚本才使用临时副本。原始 `workspace/demo-project` 故意保留失败代码，便于下一次复现。下一课再处理事件流、取消和用户插话。
