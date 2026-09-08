import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResponsesTurn } from "../src/runtime/responses-turn.js";
import { createAgentSession } from "../src/runtime/session.js";
import { createInteractiveInput } from "../src/runtime/interactive-input.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";
import { ToolRegistry } from "../src/runtime/tool-registry.js";
import { runBash } from "../src/tools/bash.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const call = (name, id = name) => ({ type: "function_call", name, call_id: id, arguments: "{}" });
const answer = (text = "完成") => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }] });
function register(registry, name, execute = async () => ({ ok: true }), safe = true) {
    return registry.register({ definition: { type: "function", name, parameters: { type: "object", properties: {}, additionalProperties: false } },
        execute, executionMode: safe ? "parallel" : "sequential", requiresApproval: !safe });
}
function setup({ respond = async () => answer(), registry = new ToolRegistry(), onEvent, beforeToolCall, afterToolCall, maxTurns } = {}) {
    const requests = [];
    const client = { responses: { create: async (body, options) => { requests.push(structuredClone(body)); return respond(body, options); } } };
    const executor = createToolExecutor({ registry, beforeToolCall, afterToolCall });
    const runTurn = createResponsesTurn({ client, model: "fixture", tools: registry.definitions() });
    return { requests, session: createAgentSession({ runTurn, executor, onEvent, maxTurns }) };
}
const outputs = (session) => session.history.filter((item) => item.type === "function_call_output");

test("Responses 保留完整 reasoning、按 call_id 补齐跳过结果，插话优先于追加", async () => {
    const reasoning = { type: "reasoning", id: "r1", content: [{ type: "reasoning_text", text: "fixture reasoning" }], summary: [] };
    const registry = register(new ToolRegistry(), "read");
    register(registry, "edit", () => assert.fail("edit 不得启动"), false);
    let count = 0;
    const events = [];
    const { session, requests } = setup({ registry,
        respond: async () => ++count === 1 ? { status: "completed", output: [reasoning, call("read"), call("edit")] } : answer(),
        afterToolCall: ({ toolCall }) => { if (toolCall.name === "read") { session.followUp("后续"); session.steer("纠偏"); } },
        onEvent: (e) => events.push(e),
    });
    assert.equal((await session.prompt("开始")).turns, 3);
    assert.deepEqual(requests[1].input[1], reasoning);
    assert.deepEqual(outputs(session).map((item) => item.call_id), ["read", "edit"]);
    assert.equal(JSON.parse(outputs(session)[1].output).error.code, "STEERING_SKIPPED");
    assert.equal(requests[1].input.at(-1).content, "纠偏");
    assert.equal(requests[2].input.at(-1).content, "后续");
    assert.deepEqual(events.filter((e) => e.type === "message").map((e) => e.kind), ["prompt", "steer", "follow_up"]);
});

test("已启动的只读批次继续并行并保留真实结果，下一轮才消费插话", async () => {
    const started = deferred();
    const release = deferred();
    let count = 0;
    const registry = register(new ToolRegistry(), "read", async () => {
        if (++count === 2) started.resolve();
        await release.promise;
        return { read: true };
    });
    let turns = 0;
    const { session } = setup({ registry, respond: async () => ++turns === 1 ? { status: "completed", output: [call("read", "r1"), call("read", "r2")] } : answer() });
    const done = session.prompt("读两个");
    await started.promise;
    session.steer("解释即可");
    release.resolve();
    assert.equal((await done).status, "completed");
    assert.equal(count, 2);
    assert.ok(outputs(session).every((item) => JSON.parse(item.output).read));
});

test("模型请求收到同一 signal，取消后可复用有效历史启动新任务", async () => {
    const started = deferred();
    let count = 0;
    const { session } = setup({ respond: async (_body, { signal }) => {
        if (++count === 1) { started.resolve(); await delay(10000, null, { signal }); }
        return answer();
    } });
    const done = session.prompt("等待");
    await started.promise;
    session.followUp("取消后不能自动执行");
    session.abort();
    assert.equal((await done).status, "cancelled");
    assert.equal((await session.prompt("新任务")).status, "completed");
    assert.equal(count, 2);
    assert.equal(session.history.filter((item) => item.role === "user").length, 2);
});

test("工具等待响应取消，剩余调用均回填 CANCELLED", async () => {
    const started = deferred();
    const registry = register(new ToolRegistry(), "write", async (_args, _root, { signal }) => {
        started.resolve(); await delay(10000, null, { signal }); return { ok: true };
    }, false);
    const { session } = setup({ registry, beforeToolCall: () => ({ allow: true }), respond: async () => ({ status: "completed", output: [call("write", "w1"), call("write", "w2")] }) });
    const done = session.prompt("写入");
    await started.promise;
    session.abort();
    assert.equal((await done).status, "cancelled");
    assert.deepEqual(outputs(session).map((item) => JSON.parse(item.output).error.code), ["CANCELLED", "CANCELLED"]);
});

test("忽略 signal 的工具成功结果不被取消覆盖", async () => {
    const started = deferred(); const release = deferred();
    const registry = register(new ToolRegistry(), "write", async () => { started.resolve(); await release.promise; return { written: true }; }, false);
    const { session } = setup({ registry, beforeToolCall: () => ({ allow: true }), respond: async () => ({ status: "completed", output: [call("write")] }) });
    const done = session.prompt("写入");
    await started.promise; session.abort(); release.resolve();
    assert.equal((await done).status, "cancelled");
    assert.deepEqual(JSON.parse(outputs(session)[0].output), { written: true });
});

test("不完整、失败、空响应和重复 call_id 不执行工具，不污染历史", async () => {
    for (const response of [
        { status: "incomplete", output: [call("read")] },
        { status: "failed", output: [] }, { status: "completed", output: [] },
        { status: "completed", output: [call("read"), call("read")] },
        { status: "completed", output: [{ type: "function_call", name: "read" }] },
    ]) {
        const { session } = setup({ respond: async () => response });
        assert.equal((await session.prompt("开始")).status, "error");
        assert.deepEqual(session.history, [{ role: "user", content: "开始" }]);
    }
});

test("连续 prompt 保留上下文，历史 getter 和观察者不能修改真实 Items", async () => {
    const { session, requests } = setup({ onEvent: (event) => { event.content = "被改"; throw new Error("observer failed"); } });
    await session.prompt("第一条");
    session.history[0].content = "被改";
    await session.prompt("第二条");
    assert.equal(requests[1].input[0].content, "第一条");
    assert.equal(requests[1].input.length, 3);
});

test("turn_end 入队仍消费；agent_end 拒绝重入；总轮数含 Follow-up", async () => {
    let reentrant;
    const { session } = setup({ maxTurns: 2, onEvent: (event) => {
        if (event.type === "turn_end") {
            if (event.turn === 1) session.steer("边界纠偏");
            else session.followUp("超过预算");
        }
        if (event.type === "agent_end") {
            assert.throws(() => session.steer("结束插话"));
            reentrant = assert.rejects(session.prompt("结束重入"), /运行中/);
            session.abort();
        }
    } });
    const result = await session.prompt("开始");
    await reentrant;
    assert.equal(result.status, "max_turns");
    assert.equal(result.turns, 2);
    assert.ok(!session.history.some((item) => item.content === "超过预算"));
});

test("统一输入：普通 y 不能批准，错票号不放行，明确批准后才启动", async () => {
    const waiting = deferred();
    const logs = [];
    const input = createInteractiveInput({ log: (line) => { logs.push(line); if (line.startsWith("输入 /approve")) waiting.resolve(); } });
    let executed = 0; let count = 0;
    const registry = register(new ToolRegistry(), "write", async () => { executed++; return { ok: true }; }, false);
    const { session } = setup({ registry, beforeToolCall: input.requestApproval, onEvent: input.observe,
        respond: async () => ++count === 1 ? { status: "completed", output: [call("write")] } : answer(),
    });
    input.bind(session); input.handleLine("写入"); await waiting.promise;
    input.handleLine("y"); input.handleLine("/approve a999 y");
    assert.equal(input.pendingApprovals, 1); assert.equal(executed, 0);
    input.handleLine("/approve a1 y"); await input.wait();
    assert.equal(executed, 1); assert.equal(input.pendingApprovals, 0);
    assert.ok(logs.some((line) => line.includes("票号不存在")));
});

test("审批等待中的插话使旧票失效；Follow-up 不抢走审批", async () => {
    const waiting = deferred();
    const input = createInteractiveInput({ log: (line) => { if (line.startsWith("输入 /approve")) waiting.resolve(); } });
    let count = 0;
    const registry = register(new ToolRegistry(), "edit", () => assert.fail("不应执行"), false);
    const { session } = setup({ registry, beforeToolCall: input.requestApproval, onEvent: input.observe,
        respond: async () => ++count === 1 ? { status: "completed", output: [call("edit")] } : answer(),
    });
    input.bind(session); input.handleLine("修改"); await waiting.promise;
    input.handleLine("/follow 测试说明"); assert.equal(input.pendingApprovals, 1);
    input.handleLine("/steer 不要改"); input.handleLine("/approve a1 y");
    await input.wait();
    assert.equal(JSON.parse(outputs(session)[0].output).error.code, "STEERING_SKIPPED");
    assert.equal(input.pendingApprovals, 0); assert.equal(count, 3);
});

test("取消或关闭输入释放审批 Promise，拒绝保留 TOOL_DENIED", async () => {
    for (const action of ["/cancel", "/exit", "/approve a1 n"]) {
        const waiting = deferred();
        const input = createInteractiveInput({ log: (line) => { if (line.startsWith("输入 /approve")) waiting.resolve(); } });
        let count = 0;
        const registry = register(new ToolRegistry(), "write", () => assert.fail("不应执行"), false);
        const { session } = setup({ registry, beforeToolCall: input.requestApproval, onEvent: input.observe,
            respond: async () => ++count === 1 ? { status: "completed", output: [call("write")] } : answer(),
        });
        input.bind(session); input.handleLine("写"); await waiting.promise; input.handleLine(action); await input.wait();
        assert.equal(input.pendingApprovals, 0); assert.equal(session.running, false);
        assert.equal(JSON.parse(outputs(session)[0].output).error.code, action.includes("approve") ? "TOOL_DENIED" : "CANCELLED");
    }
});

test("真实 Bash 取消整个前台任务进程组，并等待 close 后返回", { timeout: 10000 }, async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "ray-agent-cancel-test-"));
    const controller = new AbortController();
    let done;
    try {
        const script = "const cp=require('node:child_process'); const fs=require('node:fs'); const child=cp.spawn('sleep',['30'],{stdio:'ignore'}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)";
        done = runBash({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }, workspace, { signal: controller.signal });
        let pids;
        for (let index = 0; index < 200; index++) {
            try { pids = JSON.parse(await readFile(path.join(workspace, "pids.json"), "utf8")); break; } catch { await delay(10); }
        }
        assert.equal(pids?.length, 2, "进程必须先实际启动");
        controller.abort(); const result = await done;
        assert.equal(result.cancelled, true); assert.equal(result.timedOut, false); assert.equal(result.signal, "SIGKILL");
        for (const pid of pids) {
            let exists = true;
            for (let index = 0; index < 200; index++) {
                try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); exists = false; break; }
                await delay(10);
            }
            assert.equal(exists, false, `本测试进程 ${pid} 不得遗留`);
        }
    } finally { controller.abort(); await done; await rm(workspace, { recursive: true, force: true }); }
});

test("Bash 已取消的 signal 不启动；正常与超时调用清除取消监听器", async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runBash({ command: "printf no" }, os.tmpdir(), { signal: controller.signal }), { name: "AbortError" });
    const { getEventListeners } = await import("node:events");
    for (const args of [{ command: "printf yes" }, { command: "sleep 5", timeout: 10 }]) {
        const active = new AbortController();
        await runBash(args, os.tmpdir(), { signal: active.signal });
        assert.equal(getEventListeners(active.signal, "abort").length, 0);
    }
});

test("真实 SDK 的 AbortSignal 中断本地 HTTP 连接，不只是结束上层 Promise", { timeout: 5000 }, async () => {
    const { createServer } = await import("node:http");
    const { default: OpenAI } = await import("openai");
    const received = deferred(); const disconnected = deferred();
    const server = createServer((req, res) => { req.resume(); res.on("close", () => disconnected.resolve()); received.resolve(); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: "test-only", maxRetries: 0 });
    const runTurn = createResponsesTurn({ client, model: "fixture", tools: [] });
    const controller = new AbortController();
    try {
        const pending = runTurn({ input: [{ role: "user", content: "等待" }], signal: controller.signal });
        const rejection = assert.rejects(pending, /abort/i);
        await received.promise; controller.abort(); await rejection; await disconnected.promise;
    } finally { controller.abort(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("真实 CLI 收到 /exit 后退出，不要求父进程先关闭 stdin 管道", { timeout: 5000 }, async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["src/interactive.js"], {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, OPENAI_API_KEY: "test-only", OPENAI_BASE_URL: "https://api.deepseek.com" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
    try {
        child.stdin.write("/steer idle\n/approve a1 y\n/exit\n"); // 故意不 end。
        assert.equal(await closed, 0, stderr);
        assert.match(stdout, /会话未运行/);
        assert.match(stdout, /审批票号不存在/);
    } finally { clearTimeout(timer); child.stdin.destroy(); }
});
