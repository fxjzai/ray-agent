import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodingToolRegistry } from "./runtime/coding-tools.js";
import { createToolExecutor } from "./runtime/tool-executor.js";
import { createResponsesTurn } from "./runtime/responses-turn.js";
import { createAgentSession } from "./runtime/session.js";
import { createAgentController } from "./runtime/agent-controller.js";
import { createPublicEvents } from "./ui/public-events.js";
import { parseTerminalCommand } from "./ui/terminal-command.js";
import { createJsonlOutput } from "./ui/jsonl.js";

export async function main({ argv = process.argv.slice(2), client } = {}) {
    const jsonl = argv.includes("--jsonl") || !process.stdin.isTTY || !process.stdout.isTTY;
    if (argv.some((arg) => arg.startsWith("--") && arg !== "--jsonl")) throw new Error("只支持 --jsonl");
    const roots = argv.filter((arg) => !arg.startsWith("--"));
    if (roots.length > 1) throw new Error("只接受一个工作区路径");
    const workspaceRoot = path.resolve(roots[0] || process.cwd());
    const baseURL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
    if (new URL(baseURL).origin !== "https://api.deepseek.com") throw new Error("本课使用 DeepSeek 官方入口");
    const sdk = client ?? new OpenAI({ baseURL, timeout: 60_000, maxRetries: 0 });
    let view;
    let rl;
    let finishInput;
    const inputDone = new Promise((resolve) => { finishInput = resolve; });
    const output = createJsonlOutput((line) => process.stdout.write(line));
    const publicEvents = createPublicEvents({ secrets: [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY],
        onEvent: (event) => jsonl ? output.onEvent(event) : view.onEvent(event),
    });
    const registry = createCodingToolRegistry();
    const executor = createToolExecutor({ registry, workspaceRoot, beforeToolCall: (event) => session.requestApproval(event) });
    const session = createAgentSession({ executor, onEvent: publicEvents.emit,
        runTurn: createResponsesTurn({ client: sdk, model: process.env.MODEL_NAME || "deepseek-v4-flash", workspaceRoot, tools: registry.definitions(), stream: true }),
    });
    const controller = createAgentController(session);
    function diagnostic(text) {
        const safe = publicEvents.clean(text);
        if (jsonl) process.stderr.write(`${safe}\n`); else view.notice(safe);
    }
    function close() { controller.close(); rl?.close(); finishInput(); }
    function line(value) {
        try {
            const command = jsonl ? (value.trim() ? JSON.parse(value) : undefined) : parseTerminalCommand(value);
            if (!command) return;
            controller.dispatch(command);
            if (controller.closed) close();
        } catch (error) { diagnostic(error.message); }
    }
    function interrupt(kind) { if (kind === "exit" || !session.running) close(); else session.abort(); }
    const onSignal = () => close();
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    try {
        if (jsonl) {
            rl = readline.createInterface({ input: process.stdin, terminal: false });
            rl.on("line", line);
            rl.once("close", () => { controller.close(); finishInput(); });
        } else {
            const { createTerminalView } = await import("./ui/tui.js");
            view = createTerminalView({ onLine: line, onInterrupt: interrupt });
            view.notice(`工作区：${publicEvents.clean(workspaceRoot)}\n模型流式回答；Ctrl+C 取消，Ctrl+D 退出。审批始终显式决定。`);
            view.start();
        }
        await inputDone;
        await controller.wait();
    } finally {
        controller.close();
        await controller.wait();
        view?.stop();
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        process.stdin.pause();
        process.stdin.unref?.();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try { await main(); } catch (error) {
        const safe = createPublicEvents({ secrets: [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY], onEvent() {} });
        process.stderr.write(`${safe.clean(error.message)}\n`); process.exitCode = 1;
    }
}
