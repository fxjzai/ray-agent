// --live 才调用 DeepSeek；默认为固定 Responses fixture + 真实文件工具/Bash。
// 所有输入和审批均由脚本注入，不伪装成人工操作；只使用临时工作区。
import "dotenv/config";
import OpenAI from "openai";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, realpath, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createCodingToolRegistry } from "../src/runtime/coding-tools.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";
import { createResponsesTurn } from "../src/runtime/responses-turn.js";
import { createAgentSession } from "../src/runtime/session.js";
import { createInteractiveInput } from "../src/runtime/interactive-input.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const live = process.argv.includes("--live");
const secrets = [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY].filter(Boolean);
const transcript = [];
let workspace;
function emit(event) {
    let line = JSON.stringify(event).replaceAll(repo, "<repo>/");
    if (workspace) line = line.replaceAll(workspace, "<workspace>");
    for (const secret of secrets) line = line.replaceAll(secret, "<redacted>");
    transcript.push(line);
    console.log(line);
}
const tool = (name, args, call_id) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id });
const answer = (text) => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }] });

async function snapshot(directory, prefix = "") {
    const entries = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) entries.push(...await snapshot(path.join(directory, entry.name), relative));
        else entries.push([relative, (await readFile(path.join(directory, entry.name))).toString("base64")]);
    }
    return entries.sort(([a], [b]) => a.localeCompare(b));
}

async function demo(scenario) {
    workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "ray-agent-lesson05-")));
    let session;
    let input;
    const timers = [];
    const records = [];
    try {
        await cp(path.join(repo, "workspace/demo-project"), workspace, { recursive: true });
        const before = await snapshot(workspace);
        emit({ event: "scenario_start", scenario, provider: live ? "DeepSeek" : "fixture", inputSource: "scripted", timestamp: new Date().toISOString() });
        const registry = createCodingToolRegistry();
        const read = registry.get("read").execute;
        let injected = false;
        function send(text) { emit({ event: "input", text, source: "scripted" }); input.handleLine(text); }
        registry.get("read").execute = async (args, root, { signal }) => {
            const result = await read(args, root);
            if (scenario === "steering" && !injected) {
                injected = true;
                // 放慢真实 read 的返回，明确显示输入发生在工具运行窗口。
                emit({ event: "demo_gate", reason: "真实 read 已读完，延迟返回 100ms 以注入消息" });
                send("/follow 完成解释后，再补充一句测试建议，不调用任何工具。");
                send("/steer 先别修改，只解释 src/math.js 中加法写成减法的问题，不调用 edit、write 或 bash。");
                await delay(100, null, { signal });
            }
            return result;
        };
        input = createInteractiveInput({ log: (text) => {
            emit({ event: "terminal", text });
            const match = /^输入 \/approve (a\d+) y/.exec(text);
            if (!match) return;
            if (scenario === "approval-cancel") send("/cancel");
            else if (scenario === "bash-cancel" && approvedCommand) send(`/approve ${match[1]} y`);
            else send(`/approve ${match[1]} n`);
        } });
        // 固定命令只打印当前 Shell PID 并等待，不允许模型自行扩大权限。
        const command = "printf 'ready:%s\\n' \"$$\"; sleep 30";
        let approvedCommand = false;
        const executor = createToolExecutor({ registry, workspaceRoot: workspace,
            beforeToolCall: (event) => {
                approvedCommand = event.toolCall.name === "bash" && event.args.command === command;
                return input.requestApproval(event);
            },
        });
        let requests = 0;
        const baseURL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
        if (live && new URL(baseURL).origin !== "https://api.deepseek.com") throw new Error("只允许 DeepSeek 官方入口");
        const sdk = live ? new OpenAI({ baseURL, timeout: 45000, maxRetries: 0 }) : undefined;
        const client = { responses: { create: async (body, options) => {
            requests++;
            emit({ event: "model_request", scenario, request: requests, itemCount: body.input.length, model: live ? body.model : "fixture" });
            if (scenario === "model-cancel") timers.push(setTimeout(() => send("/cancel"), 250));
            if (live) {
                const response = await sdk.responses.create(body, options);
                emit({ event: "model_response", request: requests, status: response.status, itemTypes: response.output?.map((item) => item.type), usage: response.usage });
                return response;
            }
            if (scenario === "model-cancel") await delay(10000, null, { signal: options.signal });
            if (requests > 1) return answer(requests === 2 ? "加法写成了减法；按插话要求只解释，不修改。" : "测试建议：验证 add(2, 3) 等于 5。");
            let calls;
            if (scenario === "steering") calls = [tool("read", { path: "src/math.js" }, "read-1"), tool("edit", { path: "src/math.js", oldText: "return a - b;", newText: "return a + b;" }, "edit-1")];
            else if (scenario === "approval-cancel") calls = [tool("write", { path: "cancelled.txt", content: "must not exist" }, "write-1")];
            else calls = [tool("bash", { command }, "bash-1")];
            return { status: "completed", output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "固定测试响应" }], summary: [] }, ...calls] };
        } } };
        session = createAgentSession({ executor, maxTurns: 6,
            runTurn: createResponsesTurn({ client, model: process.env.MODEL_NAME || "deepseek-v4-flash", workspaceRoot: workspace, tools: registry.definitions() }),
            onEvent(event) {
                records.push(event); emit(event); input.observe(event);
                if (scenario === "bash-cancel" && event.type === "tool_start" && event.name === "bash") {
                    timers.push(setTimeout(() => send("/cancel"), 250));
                }
            },
        });
        input.bind(session);
        const prompts = {
            steering: "先用 read 读取 src/math.js，然后把 add 函数中的 return a - b; 用 edit 改为 return a + b;。不读取其他文件，不运行命令。",
            "approval-cancel": "只调用 write 创建 cancelled.txt，内容为 must not exist。如果未批准就停止。",
            "bash-cancel": `仅用 bash 运行以下命令，不改写命令，不增加其他操作：${command}`,
            "model-cancel": "请解释事件循环中的微任务调度，不调用工具。",
        };
        send(prompts[scenario]);
        await input.wait();
        const end = records.findLast((event) => event.type === "agent_end");
        assert.equal(end.status, scenario === "steering" ? "completed" : "cancelled");
        assert.equal(input.pendingApprovals, 0);
        assert.deepEqual(await snapshot(workspace), before, "演示不得修改 fixture 的任何文件");
        if (scenario === "steering") {
            assert.equal(injected, true, "必须真的读取文件并注入消息");
            const messages = records.filter((event) => event.type === "message");
            assert.deepEqual(messages.map((event) => event.kind), ["prompt", "steer", "follow_up"]);
            assert.ok(!records.some((event) => event.type === "tool_start" && ["write", "edit", "bash"].includes(event.name)));
            assert.ok(end.turns >= 3);
            if (!live) assert.ok(records.some((event) => event.type === "tool_skipped" && event.result.error.code === "STEERING_SKIPPED"));
        }
        if (scenario === "bash-cancel") {
            const result = records.find((event) => event.type === "tool_end" && event.name === "bash")?.result;
            assert.equal(result?.cancelled, true);
            assert.equal(result.signal, "SIGKILL");
            const pid = Number(/ready:(\d+)/.exec(result.stdout)?.[1]);
            assert.ok(pid > 0, "命令必须真实启动");
            assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" }, "任务进程组不得遗留");
        }
        emit({ event: "verification", scenario, passed: true, filesUnchanged: true, pendingApprovals: input.pendingApprovals, status: end.status, turns: end.turns });
    } finally {
        for (const timer of timers) clearTimeout(timer);
        session?.abort(); input?.close(); await input?.wait();
        await rm(workspace, { recursive: true, force: true });
        workspace = undefined;
    }
}

try {
    for (const scenario of ["steering", "approval-cancel", "bash-cancel", "model-cancel"]) await demo(scenario);
} catch (error) {
    emit({ event: "failure", message: error.message });
    process.exitCode = 1;
} finally {
    const trace = path.join(repo, "docs/lesson-05", live ? "trace-live.jsonl" : "trace-fixture.jsonl");
    await writeFile(trace, transcript.join("\n") + "\n");
}
