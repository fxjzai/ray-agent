# Agent 教程仓库

这是随课程连续演进的 JavaScript ESM 项目。课程编号从 0 开始；第 N 篇文章对应 lesson-(N-1)。

- 阅读 README 和对应 `docs/lesson-XX/README.md` 后再改课程代码。
- 课程发布用不可变的 Git Tag；下一课的实验不能混入上一课发布 Tag。
- `.env` 是本地凭证，禁止提交或将内容写入轨迹。默认使用 DeepSeek 官方 Responses API。
- 工具结果、测试结果、模拟轨迹和真实模型轨迹必须明确区分。
- `workspace/demo-project` 故意包含失败代码；自动演示复制到临时目录，不修复仓库 fixture。
- 审批只控制本次调用是否启动，不能表述为系统沙箱。
- 验证：`npm test`、`npm run check`、`git diff --check`；新增脚本另做定向检查。
- 真实模型演示会消耗 API 用量，使用现有用户授权和配置；日志必须脱敏。
- 提交只包含本次课程的相关文件，保留其他未提交工作；不重写已发布 Tag。
- 文章正文在知识库及课程内容仓库维护；本仓库保存可运行代码、课程入口与验证证据。
