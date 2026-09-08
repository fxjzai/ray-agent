# Lesson 05 验证记录

首次验证日期：2026-09-07。代码基线 lesson-04-tool-runtime（d58d856），本记录随 lesson-05 独立提交保存。

2026-09-08 提交前复验：`npm test` 为 54/54、0 skipped（299.462042ms）；`npm run check`、26 个 JS 文件逐个 `node --check`、`git diff --check` 均退出 0。候选提交文件的常见密钥形态与尾随空格检查无匹配。下面的真实模型轨迹保留 2026-09-07 原始结果，本次没有冒充重新实跑。

## 自动测试

命令：`npm test`；实际退出码：0。

```text
1..54
# tests 54
# suites 0
# pass 54
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 253.519
```

## 静态检查

`npm run check`、新增入口/模块/演示/测试文件的 `node --check`、`git diff --check`：实际退出码 0。

新增源码没有修改 package.json、依赖或环境模板。另对未追踪文件检查尾随空格和常见 Key 形态，未发现匹配；不把这视为完整安全审计。

## 实跑

- `node scripts/demo-lesson-05.js`：退出码 0，四场景固定响应 + 真实工具验证通过。
- `node scripts/demo-lesson-05.js --live`：退出码 0，真实 DeepSeek 四场景通过。
- `node scripts/demo-cli-lesson-05.js`：修复 stdin 保活后重跑，退出码 0，真实 CLI 三轮后 /exit 正常退出。

对应 [fixture](trace-fixture.jsonl)、[DeepSeek](trace-live.jsonl)、[CLI](trace-cli.txt)。轨迹经过已配置 Key 和临时工作区路径脱敏；模型 reasoning 只保留在会话历史，不写入这些轨迹。

第一次 CLI 实跑对话正确但退出失败，结束测试进程后修复；不能把该次称为全程通过。回归用例保持父进程 stdin 打开，验证不依赖 EOF 也能退出。
