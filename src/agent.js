import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline/promises";
import path from "node:path";
import { createCodingToolRegistry } from "./runtime/coding-tools.js";
import { createToolExecutor } from "./runtime/tool-executor.js";
import { createApprovalHook, logToolResult } from "./runtime/approval.js";
import { createAgent } from "./runtime/agent-loop.js";

// SDK 读取 .env 中的 OPENAI_API_KEY / OPENAI_BASE_URL，连接 DeepSeek。
const client = new OpenAI();
const model = process.env.MODEL_NAME || "deepseek-v4-flash";
const workspaceRoot = path.resolve(process.argv[2] || process.cwd());
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const registry = createCodingToolRegistry();
const executor = createToolExecutor({
    registry,
    workspaceRoot,
    beforeToolCall: createApprovalHook({ question: (prompt) => rl.question(prompt) }),
    afterToolCall: logToolResult,
    onHookError: () => console.error("审计 Hook 失败；工具结果保留，请检查日志处理逻辑"),
});
const runAgent = createAgent({ client, model, workspaceRoot, tools: registry.definitions(), executor });

console.log(`工作区：${workspaceRoot}\nread 自动执行；write / edit / bash 逐次审批。\n`);
try {
    while (true) {
        let userInput;
        try {
            userInput = (await rl.question("你: ")).trim();
        } catch (error) {
            if (error.code === "ERR_USE_AFTER_CLOSE") break;
            throw error;
        }
        if (["退出", "exit", "quit"].includes(userInput.toLowerCase())) break;
        if (!userInput) continue;
        try {
            console.log(`AI: ${await runAgent(userInput)}\n`);
        } catch (error) {
            console.error(`运行失败：${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
} finally {
    rl.close();
}
