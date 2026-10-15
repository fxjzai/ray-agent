// 固定流/真实 DeepSeek 分开采集；输入由脚本注入，所有操作限制在临时 fixture 副本。
import "dotenv/config";
import OpenAI from "openai";
import assert from "node:assert/strict";
import { cp, mkdtemp, realpath, readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createCodingToolRegistry } from "../src/runtime/coding-tools.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";
import { createResponsesTurn } from "../src/runtime/responses-turn.js";
import { createAgentSession } from "../src/runtime/session.js";
import { createAgentController } from "../src/runtime/agent-controller.js";
import { createPublicEvents } from "../src/ui/public-events.js";
import { createViewState } from "../src/ui/view-state.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const live = process.argv.includes("--live");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ray-agent-lesson06-")));
const records = [];
const safe = createPublicEvents({ secrets: [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY, root], onEvent(event) {
    const line = JSON.stringify(event); records.push(line); console.log(line);
} });
const log = (event) => safe.emit(event);
const message = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const tool = (name, args, id) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
async function snapshot(directory, prefix = "") {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...await snapshot(path.join(directory, entry.name), relative));
        else files.push([relative, (await readFile(path.join(directory, entry.name))).toString("base64")]);
    }
    return files.sort(([a], [b]) => a.localeCompare(b));
}
async function scenario(name) {
    const workspaceRoot = path.join(root, name);
    await cp(path.join(repo, "workspace/demo-project"), workspaceRoot, { recursive: true });
    const before = await snapshot(workspaceRoot);
    const registry = createCodingToolRegistry();
    const events = [];
    const view = createViewState();
    let request = 0;
    let cancelled = false;
    let steered = false;
    log({ type: "scenario_start", scenario: name, provider: live ? "DeepSeek" : "fixture", inputSource: "scripted", timestamp: new Date().toISOString() });
    const baseURL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
    if (live && new URL(baseURL).origin !== "https://api.deepseek.com") throw new Error("只允许 DeepSeek 官方入口");
    const sdk = live ? new OpenAI({ baseURL, timeout: 60_000, maxRetries: 0 }) : undefined;
    const client = { responses: { create: async (body, options) => {
        request++;
        if (live) return sdk.responses.create(body, options);
        const output = [];
        if (name !== "cancel-stream" && request === 1) {
            output.push(tool("read", { path: "src/math.js" }, "r1"));
            if (name === "approval-steer") output.push(tool("edit", { path: "src/math.js", oldText: "return a - b;", newText: "return a + b;" }, "e1"));
        } else output.push(message(request > 2 ? "建议验证 add(1, 2) === 3。" : "函数名表示加法，但实现执行了减法。先解释，不修改。"));
        return (async function* () {
            for (const [output_index, item] of output.entries()) {
                yield { type: "response.output_item.added", output_index, item };
                if (item.type === "message") {
                    for (const delta of [item.content[0].text.slice(0, 5), item.content[0].text.slice(5)]) {
                        options.signal.throwIfAborted();
                        yield { type: "response.output_text.delta", output_index, content_index: 0, delta };
                    }
                }
            }
            options.signal.throwIfAborted();
            yield { type: "response.completed", response: { status: "completed", output } };
        })();
    } } };
    const executor = createToolExecutor({ registry, workspaceRoot, beforeToolCall: (e) => session.requestApproval(e) });
    const session = createAgentSession({ executor, maxTurns: 6,
        runTurn: createResponsesTurn({ client, model: process.env.MODEL_NAME || "deepseek-v4-flash", workspaceRoot, tools: registry.definitions(), stream: true }),
        onEvent(event) {
            events.push(event); view.update(event); log(event);
            if (event.type === "approval_requested") {
                if (name === "approval-steer" && !steered && event.name === "edit") {
                    steered = true;
                    controller.dispatch({ type: "follow_up", content: "完成后仅补一句测试建议，不调用任何工具。" });
                    controller.dispatch({ type: "steer", content: "先别修改，只解释加法写成减法的问题，一句话，不调用任何工具。" });
                } else controller.dispatch({ type: "approve", approvalId: event.approvalId, allow: false });
            }
            if (name === "cancel-stream" && event.type === "text_delta" && !cancelled) {
                cancelled = true; controller.dispatch({ type: "cancel" });
            }
        },
    });
    const controller = createAgentController(session);
    const prompts = {
        stream: "先 read src/math.js，再用三句话解释加法写成减法的问题。不修改，不调用 bash。",
        "approval-steer": "先 read src/math.js，再 edit 把 return a - b; 改为 return a + b;，不要运行命令。",
        "cancel-stream": "不调用任何工具。请用中文详细说明十种软件测试方法，每种至少两句话。",
    };
    try {
        log({ type: "scripted_input", command: { type: "prompt", content: prompts[name] } });
        controller.dispatch({ type: "prompt", content: prompts[name] });
        const result = await controller.wait();
        assert.equal(result.status, name === "cancel-stream" ? "cancelled" : "completed");
        assert.ok(events.some(e => e.type === "text_delta"));
        if (name === "approval-steer") {
            assert.ok(steered, "必须真实到达 edit 审批");
            assert.ok(events.some(e => e.type === "tool_skipped" && e.result.error.code === "STEERING_SKIPPED"));
            assert.deepEqual(events.filter(e => e.type === "message").map(e => e.kind), ["prompt", "steer", "follow_up"]);
        }
        const ended = events.filter(e => e.type === "message_end");
        if (name === "cancel-stream") assert.ok(ended.some(e => e.status === "cancelled"));
        else for (const end of ended) {
            assert.equal(events.filter(e => e.type === "text_delta" && e.messageId === end.messageId).map(e => e.delta).join(""), end.text);
        }
        assert.deepEqual(await snapshot(workspaceRoot), before);
        const replay = createViewState();
        // JSON 序列化后的事件必须得到相同的 UI 投影。
        events.map(e => JSON.parse(JSON.stringify(e))).forEach(replay.update);
        assert.deepEqual(replay.snapshot(), view.snapshot());
        log({ type: "verification", scenario: name, status: result.status, turns: result.turns, filesUnchanged: true,
            textDeltas: events.filter(e => e.type === "text_delta").length, viewMatchesJsonl: true });
    } finally { controller.close(); await controller.wait(); }
}
try {
    for (const name of ["stream", "approval-steer", "cancel-stream"]) await scenario(name);
} catch (error) {
    log({ type: "verification_failed", message: error.message }); process.exitCode = 1;
} finally {
    const directory = path.join(repo, "docs/lesson-06");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, live ? "trace-live.jsonl" : "trace-fixture.jsonl"), records.join("\n") + "\n");
    await rm(root, { recursive: true, force: true });
}
