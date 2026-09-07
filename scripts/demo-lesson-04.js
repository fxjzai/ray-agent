// 真实 DeepSeek + 真实四工具。审批由受限演示策略提供，不伪装成人工点击。
// 每次复制故意带错的 fixture 到临时目录，只允许固定测试命令和目标修复。
import "dotenv/config";
import OpenAI from "openai";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodingToolRegistry } from "../src/runtime/coding-tools.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";
import { createAgent } from "../src/runtime/agent-loop.js";
import { runBash } from "../src/tools/bash.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const model = process.env.MODEL_NAME || "deepseek-v4-flash";
const baseURL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
if (new URL(baseURL).origin !== "https://api.deepseek.com") {
    throw new Error("本演示要求 DeepSeek 官方入口 https://api.deepseek.com");
}
const client = new OpenAI({ baseURL, timeout: 60_000, maxRetries: 0 });
const secrets = [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY].filter(Boolean);
function emit(event, workspace) {
    let line = JSON.stringify(event);
    if (workspace) line = line.replaceAll(workspace, "<workspace>");
    line = line.replaceAll(repo, "<repo>/");
    for (const secret of secrets) line = line.replaceAll(secret, "<redacted>");
    console.log(line);
}

async function demo(scenario) {
    const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "ray-agent-lesson04-")));
    try {
        await cp(path.join(repo, "workspace/demo-project"), workspace, { recursive: true });
        const initial = await readFile(path.join(workspace, "src/math.js"), "utf8");
        assert.ok(initial.includes("return a - b;"), "fixture 应保留故意写错的加法");
        emit({ event: "start", scenario, model, provider: baseURL, timestamp: new Date().toISOString(), approvalMode: "scripted-policy" });
        const records = [];
        const registry = createCodingToolRegistry();
        const executor = createToolExecutor({
            registry, workspaceRoot: workspace,
            beforeToolCall: async ({ toolCall, args, tool }) => {
                emit({ event: "call", name: toolCall.name, call_id: toolCall.call_id, args }, workspace);
                if (!tool.requiresApproval) return;
                const allow = scenario === "approve-fix" && (
                    (toolCall.name === "bash" && ["npm test", "npm test 2>&1"].includes(args.command)) ||
                    (toolCall.name === "edit" && args.path === "src/math.js" &&
                        initial.includes(args.oldText) && args.oldText.length > 0 &&
                        initial.replace(args.oldText, args.newText) === initial.replace("return a - b;", "return a + b;"))
                );
                emit({ event: "approval", name: toolCall.name, allow, source: "scripted-policy" });
                return { allow, reason: allow ? undefined : "演示策略拒绝本次操作，请停止，不要重试或换工具绕过" };
            },
            afterToolCall: (event) => {
                records.push(event);
                emit({ event: "result", name: event.toolCall.name, call_id: event.toolCall.call_id, result: event.result, durationMs: Math.round(event.durationMs) }, workspace);
            },
            onHookError: () => { throw new Error("演示记录 Hook 失败"); },
        });
        const runAgent = createAgent({ client, model, workspaceRoot: workspace, tools: registry.definitions(), executor });
        const prompt = scenario === "approve-fix"
            ? "这是一个受限演示项目。先读取 src/math.js、test/math.test.js 和 package.json，再用 bash 执行 npm test 观察失败，使用 edit 把 src/math.js 的 return a - b; 精确替换为 return a + b;，再执行 npm test 验证。命令只用 npm test，不搜索目录，不改其他文件。根据实际工具结果报告。"
            : "请用 write 工具创建 approval-denied.txt，内容为 approval demo。如果审批拒绝，请停止写入，不重试，不换其他工具，明确说明文件未创建。";
        emit({ event: "prompt", text: prompt });
        const answer = await runAgent(prompt);
        emit({ event: "answer", text: answer }, workspace);
        if (scenario === "approve-fix") {
            const failedTestIndex = records.findIndex((r) => r.toolCall.name === "bash" && Number.isInteger(r.result.exitCode) && r.result.exitCode !== 0);
            const editIndex = records.findIndex((r) => r.toolCall.name === "edit" && !r.result.error);
            assert.ok(failedTestIndex >= 0 && editIndex > failedTestIndex, "必须先观察真实测试失败，再成功编辑");
            assert.equal(records.filter((r) => r.toolCall.name === "bash").at(-1).result.exitCode, 0);
            assert.ok((await readFile(path.join(workspace, "src/math.js"), "utf8")).includes("return a + b;"));
            const verification = await runBash({ command: "npm test" }, workspace);
            assert.equal(verification.exitCode, 0);
            emit({ event: "verification", scenario, passed: true, independentTestExitCode: verification.exitCode, sourceFixed: true });
        } else {
            assert.ok(records.some((r) => r.result.error?.code === "TOOL_DENIED"));
            await assert.rejects(access(path.join(workspace, "approval-denied.txt")), { code: "ENOENT" });
            assert.equal(await readFile(path.join(workspace, "src/math.js"), "utf8"), initial);
            emit({ event: "verification", scenario, passed: true, deniedFileExists: false, sourceUnchanged: true });
        }
    } finally {
        // 只清理本进程 mkdtemp 创建的演示副本，仓库 fixture 保持原样。
        await rm(workspace, { recursive: true, force: true });
    }
}

try {
    for (const scenario of ["approve-fix", "deny-write"]) await demo(scenario);
} catch (error) {
    emit({ event: "failure", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
}
