import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline";
import path from "node:path";
import { createCodingToolRegistry } from "./runtime/coding-tools.js";
import { createToolExecutor } from "./runtime/tool-executor.js";
import { createResponsesTurn } from "./runtime/responses-turn.js";
import { createAgentSession } from "./runtime/session.js";
import { createInteractiveInput } from "./runtime/interactive-input.js";

const workspaceRoot = path.resolve(process.argv[2] || process.cwd());
const baseURL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
if (new URL(baseURL).origin !== "https://api.deepseek.com") throw new Error("本课使用 DeepSeek 官方入口");
const client = new OpenAI({ baseURL, timeout: 60_000, maxRetries: 0 });
const registry = createCodingToolRegistry();
const secrets = [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY].filter(Boolean);
function log(value) {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, "<redacted>");
    // 供应商与工具文本不能向终端写入 ANSI 控制序列。
    console.log(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
}
const input = createInteractiveInput({ log });
const executor = createToolExecutor({ registry, workspaceRoot, beforeToolCall: input.requestApproval });
const session = createAgentSession({
    executor,
    runTurn: createResponsesTurn({ client, model: process.env.MODEL_NAME || "deepseek-v4-flash", workspaceRoot, tools: registry.definitions() }),
    onEvent(event) {
        input.observe(event);
        if (event.type === "answer") log(`AI: ${event.text}`);
        else log(JSON.stringify(event));
    },
});
input.bind(session);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
log(`工作区：${workspaceRoot}\n输入任务开始；运行中使用 /steer 内容、/follow 内容、/cancel。审批按提示带票号，/exit 退出。`);
rl.on("line", (line) => { input.handleLine(line); if (input.closed) rl.close(); });
rl.on("SIGINT", () => { if (session.running) session.abort(); else rl.close(); });
await new Promise((resolve) => rl.once("close", resolve));
input.close();
await input.wait();
// readline 关闭不保证外部仍打开的 stdin 管道不再保活；任务收尾后释放句柄。
process.stdin.pause();
process.stdin.unref?.();
