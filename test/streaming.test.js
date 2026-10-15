import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import OpenAI from "openai";
import { createResponsesTurn } from "../src/runtime/responses-turn.js";
import { createAgentSession } from "../src/runtime/session.js";
import { createApprovalBroker } from "../src/runtime/approval-broker.js";
import { createAgentController } from "../src/runtime/agent-controller.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";
import { ToolRegistry } from "../src/runtime/tool-registry.js";
import { createPublicEvents } from "../src/ui/public-events.js";
import { createViewState } from "../src/ui/view-state.js";
import { createJsonlOutput } from "../src/ui/jsonl.js";
import { parseTerminalCommand } from "../src/ui/terminal-command.js";
import { createTerminalView } from "../src/ui/tui.js";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const msg = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (id = "w1") => ({ type: "function_call", call_id: id, name: "write", arguments: "{}" });
const start = (index = 0) => ({ type: "response.output_item.added", output_index: index, item: msg("") });
const delta = (text, index = 0, part = 0) => ({ type: "response.output_text.delta", output_index: index, content_index: part, delta: text });
const final = (output = [msg("完成")]) => ({ type: "response.completed", response: { status: "completed", output } });
async function* events(values) { yield* values; }
function setup({ respond = () => events([start(), delta("完成"), final()]), registry = new ToolRegistry(), onEvent, maxTurns } = {}) {
    const observed = []; const requests = [];
    const client = { responses: { create: async (body, options) => { requests.push(structuredClone(body)); return respond(body, options); } } };
    const executor = createToolExecutor({ registry, beforeToolCall: (e) => session.requestApproval(e) });
    const session = createAgentSession({ executor, maxTurns,
        runTurn: createResponsesTurn({ client, model: "fixture", tools: registry.definitions(), stream: true }),
        onEvent(e) { observed.push(e); return onEvent?.(e); },
    });
    return { session, observed, requests };
}
function writable(execute = () => assert.fail("不可执行")) {
    return new ToolRegistry().register({ definition: { type: "function", name: "write", parameters: { type: "object", properties: {}, additionalProperties: false } }, execute });
}

test("真实增量在完成前可观察，正式历史只在完成后采用，全文不重复", async () => {
    const received = deferred(); const release = deferred();
    const reasoning = { type: "reasoning", content: [{ type: "reasoning_text", text: "内部材料" }] };
    const { session, observed } = setup({ respond: async function* () {
        yield { type: "response.reasoning_text.delta", delta: "内部材料" };
        yield start(1); yield delta("你", 1); received.resolve(); await release.promise;
        yield delta("好", 1); yield final([reasoning, msg("你好")]);
    } });
    const done = session.prompt("问候"); await received.promise;
    assert.equal(observed.filter(e => e.type === "text_delta").length, 1);
    assert.deepEqual(session.history, [{ role: "user", content: "问候" }]);
    release.resolve(); assert.equal((await done).text, "你好");
    assert.deepEqual(session.history[1], reasoning);
    assert.equal(observed.some(e => e.type === "answer"), false);
    assert.equal(JSON.stringify(observed).includes("内部材料"), false);
    assert.equal(observed.filter(e => e.type === "message_end").length, 1);
    assert.deepEqual(observed.map(e => e.sequence), observed.map((_, index) => index + 1));
});

test("多个 message/part 按索引归并，最终快照校准而非追加", async () => {
    const { session, observed } = setup({ respond: () => events([
        start(), delta("后", 0, 1), delta("前", 0, 0), start(1), delta("草稿", 1), final([msg("前后"), msg("定稿")]),
    ]) });
    await session.prompt("开始");
    const state = createViewState(); observed.forEach(state.update);
    assert.deepEqual(state.snapshot().entries.filter(e => e.kind === "assistant").map(e => e.text), ["前后", "定稿"]);
    assert.equal(new Set(observed.filter(e => e.type === "message_start").map(e => e.messageId)).size, 2);
});

test("没有 delta 的完整响应也产生一对消息生命周期", async () => {
    const { session, observed } = setup({ respond: () => events([final()]) });
    assert.equal((await session.prompt("开始")).status, "completed");
    assert.deepEqual(observed.filter(e => e.type.startsWith("message_")).map(e => e.type), ["message_start", "message_end"]);
});

for (const ending of ["response.incomplete", "response.failed", "error", "eof", "throw"]) {
    test(`${ending} 保留未完成文本，不采用残缺工具调用或污染历史`, async () => {
        const { session, observed } = setup({ registry: writable(), respond: async function* () {
            yield start(); yield delta("只收到一半");
            yield { type: "response.function_call_arguments.delta", delta: "{}" };
            yield { type: "response.output_item.done", output_index: 1, item: call() };
            if (ending === "throw") throw new Error("断网");
            if (ending !== "eof") yield { type: ending, response: { status: "incomplete", output: [msg("只收到一半"), call()] } };
        } });
        assert.equal((await session.prompt("开始")).status, "error");
        assert.equal(session.history.length, 1);
        const end = observed.filter(e => e.type === "message_end");
        assert.equal(end.length, 1); assert.equal(end[0].text, "只收到一半");
        assert.equal(end[0].status, ending === "response.incomplete" ? "incomplete" : "error");
        assert.equal(observed.some(e => e.type === "approval_requested" || e.type === "tool_start"), false);
    });
}

test("流式取消保留片段状态，关闭 iterator，可复用会话且 ID 不重复", async () => {
    const started = deferred(); let closed = false; let requests = 0;
    const { session, observed } = setup({ respond: async function* (_body, { signal }) {
        if (++requests > 1) { yield final(); return; }
        try { yield start(); yield delta("半段"); started.resolve(); await delay(10000, null, { signal }); }
        finally { closed = true; }
    } });
    const first = session.prompt("等待"); await started.promise; session.abort();
    const firstResult = await first; assert.equal(firstResult.status, "cancelled"); assert.equal(closed, true);
    assert.equal(observed.find(e => e.type === "message_end").status, "cancelled");
    const second = await session.prompt("继续"); assert.notEqual(firstResult.runId, second.runId);
    assert.equal(observed.filter(e => e.type === "agent_start").every(e => e.sequence === 1), true);
});

test("模型完整响应到达之前，即使参数能解析也不审批或执行", async () => {
    const ready = deferred(); const release = deferred(); let count = 0; let ran = 0;
    const { session, observed } = setup({ registry: writable(() => { ran++; return { written: true }; }),
        respond: async function* () {
            if (++count > 1) { yield final(); return; }
            yield { type: "response.function_call_arguments.delta", delta: "{}" };
            yield { type: "response.output_item.done", output_index: 0, item: call() };
            ready.resolve(); await release.promise; yield final([call()]);
        },
        onEvent(e) { if (e.type === "approval_requested") session.approve({ approvalId: e.approvalId, allow: true }); },
    });
    const done = session.prompt("写"); await ready.promise;
    assert.equal(ran, 0); assert.equal(observed.some(e => e.type === "approval_requested"), false);
    release.resolve(); assert.equal((await done).status, "completed"); assert.equal(ran, 1);
});

test("畸形 delta、流和 final 不匹配、重复 call_id 都不能执行", async () => {
    for (const list of [[delta("x", -1)], [start(3), final()], [start(), delta("半段"), final([msg("完成"), call(), call()])]]) {
        const { session } = setup({ registry: writable(), respond: () => events(list) });
        assert.equal((await session.prompt("开始")).status, "error"); assert.equal(session.history.length, 1);
    }
});

test("无 CLI：Steering 撤销审批、Follow-up 不抢审批，旧票不可误批准", async () => {
    const ready = deferred(); let count = 0;
    const { session, observed, requests } = setup({ registry: writable(),
        respond: () => events([final(++count === 1 ? [call()] : [msg("说明")])]),
        onEvent(e) { if (e.type === "approval_requested") ready.resolve(e.approvalId); },
    });
    const done = session.prompt("写入"); const ticket = await ready.promise;
    session.followUp("补测试"); assert.equal(session.pendingApprovals, 1);
    session.steer("别写"); assert.equal(session.pendingApprovals, 0);
    assert.throws(() => session.approve({ approvalId: ticket, allow: true }), /失效/);
    assert.equal((await done).turns, 3);
    assert.equal(requests[1].input.at(-1).content, "别写");
    assert.equal(requests[2].input.at(-1).content, "补测试");
    assert.equal(observed.find(e => e.type === "tool_skipped").result.error.code, "STEERING_SKIPPED");
});

test("不订阅 UI 也能取消审批；订阅者抛错不会放行", async () => {
    let count = 0;
    const { session } = setup({ registry: writable(), respond: () => events([final(++count === 1 ? [call()] : [msg("好")])]), onEvent: async () => { throw new Error("UI 故障"); } });
    const done = session.prompt("写");
    for (let i = 0; i < 20 && !session.pendingApprovals; i++) await delay(0);
    assert.equal(session.pendingApprovals, 1); session.abort();
    assert.equal((await done).status, "cancelled"); assert.equal(session.pendingApprovals, 0);
});

test("审批要求 boolean、拒绝保留结果；票号跨运行不复用", async () => {
    const tickets = []; let requests = 0;
    const { session, observed } = setup({ registry: writable(), respond: () => events([final(++requests % 2 ? [call(`w${requests}`)] : [msg("拒绝后结束")])]),
        onEvent(e) {
            if (e.type !== "approval_requested") return;
            tickets.push(e.approvalId);
            assert.throws(() => session.approve({ approvalId: e.approvalId, allow: "true" }), /布尔/);
            session.approve({ approvalId: e.approvalId, allow: false });
        },
    });
    await session.prompt("一"); await session.prompt("二");
    assert.deepEqual(tickets, ["a1", "a2"]);
    assert.ok(observed.filter(e => e.type === "tool_end").every(e => e.result.error.code === "TOOL_DENIED"));
});

test("Broker 清理 AbortSignal 监听器，错误票号和重复批准失败", async () => {
    const abort = new AbortController(); let ticket;
    const broker = createApprovalBroker({ onEvent(e) { if (e.type === "approval_requested") ticket = e.approvalId; } });
    const pending = broker.request({ toolCall: call(), tool: { requiresApproval: true }, args: {}, signal: abort.signal });
    assert.equal(getEventListeners(abort.signal, "abort").length, 1);
    broker.resolve({ approvalId: ticket, allow: false }); await pending;
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.throws(() => broker.resolve({ approvalId: ticket, allow: true }), /失效/);
});

test("结构化控制不等待 prompt 完成，输入解析不隐式批准", async () => {
    const started = deferred();
    const { session } = setup({ respond: async function* (_body, { signal }) { started.resolve(); await delay(10000, null, { signal }); } });
    const controller = createAgentController(session);
    assert.throws(() => controller.dispatch({ type: "prompt", content: " " }), /不能为空/);
    assert.equal(controller.dispatch({ type: "prompt", content: "任务" }).accepted, true);
    await started.promise;
    assert.throws(() => controller.dispatch({ type: "prompt", content: "另一个" }), /正在运行/);
    assert.deepEqual(parseTerminalCommand("y"), { type: "prompt", content: "y" });
    assert.deepEqual(parseTerminalCommand("/approve a1 n"), { type: "approve", approvalId: "a1", allow: false });
    controller.dispatch({ type: "exit" }); assert.equal((await controller.wait()).status, "cancelled");
    assert.throws(() => controller.dispatch({ type: "cancel" }), /关闭/);
});

test("跨文本片段密钥脱敏，控制字符和异常尾部前缀不漏出", () => {
    const output = []; const secret = "secret-value-123";
    const pub = createPublicEvents({ secrets: [secret], onEvent(e) { output.push(e); } });
    pub.emit({ type: "message_start", messageId: "m" });
    for (const value of ["你好 sec", "ret-value-", "123\u001b[2J 完成"]) pub.emit({ type: "text_delta", messageId: "m", partIndex: 0, delta: value });
    pub.emit({ type: "message_end", messageId: "m", status: "completed", text: `你好 ${secret}\u001b[2J 完成` });
    assert.equal(JSON.stringify(output).includes(secret), false);
    const text = output.filter(e => e.type === "text_delta").map(e => e.delta).join("");
    assert.match(text, /<redacted>/); assert.equal(text.includes("\u001b"), false);
    pub.emit({ type: "message_end", messageId: "other", status: "cancelled", text: "你好 secret-val" });
    assert.equal(output.at(-1).text, "你好 <redacted>");
});

test("相同事件驱动 JSONL 与界面，终态及文本一致", async () => {
    const { session, observed } = setup(); await session.prompt("你好");
    let lines = ""; const jsonl = createJsonlOutput(line => { lines += line; });
    const direct = createViewState(); const replay = createViewState();
    for (const event of observed) { direct.update(event); jsonl.onEvent(event); }
    for (const line of lines.trim().split("\n")) replay.update(JSON.parse(line));
    assert.deepEqual(replay.snapshot(), direct.snapshot());
    assert.equal(direct.snapshot().entries.filter(e => e.kind === "assistant").length, 1);
});

function virtualTerminal() {
    return { columns: 80, rows: 24, kittyProtocolActive: false, data: "", start(input, resize) { this.input = input; this.resize = resize; }, stop() {},
        write(data) { this.data += data; }, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
        moveBy() {}, setTitle() {}, setProgress() {}, async drainInput() {} };
}

test("真实 Pi 组件：流更新不清除用户输入，中文/窄屏不溢出，完整审批可查", () => {
    const terminal = virtualTerminal(); const submitted = [];
    const view = createTerminalView({ terminal, onLine: line => submitted.push(line), onInterrupt() {} });
    try {
        view.start(); view.input.setValue("还没提交的中文");
        view.onEvent({ type: "message_start", messageId: "m" });
        view.onEvent({ type: "text_delta", messageId: "m", partIndex: 0, delta: "你好🌟世界".repeat(10) });
        view.onEvent({ type: "approval_requested", approvalId: "a1", callId: "c1", name: "edit", args: { path: "文件.js", oldText: "before", newText: "after" } });
        assert.equal(view.input.getValue(), "还没提交的中文");
        for (const width of [20, 40, 80]) {
            const lines = view.tui.render(width);
            assert.ok(lines.every(line => visibleWidth(line) <= width));
            const text = lines.map(stripTerminalSequences).join("\n");
            assert.match(text, /before/); assert.match(text, /after/);
        }
        view.input.handleInput("\r"); assert.deepEqual(submitted, ["还没提交的中文"]);
        assert.equal(view.input.getValue(), "");
    } finally { view.stop(); }
});

test("真实 SDK SSE：UTF-8 字节分片、参数流、完成边界", { timeout: 5000 }, async () => {
    let requestBody;
    const server = createServer((req, res) => {
        const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
            requestBody = JSON.parse(Buffer.concat(chunks));
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            const list = [start(), delta("中文🌟"), final([msg("中文🌟")])];
            const bytes = Buffer.from(list.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
            for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
            res.end();
        });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const client = new OpenAI({ apiKey: "test-only", baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
        const runTurn = createResponsesTurn({ client, model: "fixture", tools: [], stream: true });
        const result = await runTurn({ input: [], signal: new AbortController().signal });
        assert.equal(result.text, "中文🌟"); assert.equal(requestBody.stream, true);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("真实 SDK SSE 取消关闭 HTTP，消息与任务均不冒充完成", { timeout: 5000 }, async () => {
    const received = deferred(); const disconnected = deferred();
    const server = createServer((req, res) => {
        req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const e of [start(), delta("半段")]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.on("close", disconnected.resolve);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const abort = new AbortController(); const output = [];
    try {
        const client = new OpenAI({ apiKey: "test-only", baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
        const run = createResponsesTurn({ client, model: "fixture", tools: [], stream: true });
        const pending = run({ input: [], signal: abort.signal, onEvent(e) { output.push(e); if (e.type === "text_delta") received.resolve(); } });
        const rejects = assert.rejects(pending, /abort/i);
        await received.promise; abort.abort(); await rejects; await disconnected.promise;
        assert.equal(output.at(-1).status, "cancelled");
    } finally { abort.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("JSONL 进程只向 stdout 写事件；非法命令走 stderr；exit 不依赖 EOF", { timeout: 5000 }, async () => {
    const child = spawn(process.execPath, ["src/streaming.js", "--jsonl"], { cwd: new URL("../", import.meta.url),
        env: { ...process.env, OPENAI_API_KEY: "test-only", OPENAI_BASE_URL: "https://api.deepseek.com" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 2500);
    try {
        child.stdin.write('invalid\n{"type":"approve","approvalId":"a1","allow":true}\n{"type":"exit"}\n');
        assert.equal(await done, 0); assert.equal(stdout, ""); assert.match(stderr, /失效/);
    } finally { clearTimeout(timer); child.stdin.destroy(); }
});

test("真实 JSONL 双向入口：请求审批→结构化拒绝→完整回答→退出，文件未创建", { timeout: 5000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ray-agent-jsonl-test-"));
    const code = `
        import { main } from './src/streaming.js';
        let count = 0;
        const client = {responses: {create: async () => (async function* () {
            const output = ++count === 1
                ? [{type:'function_call',call_id:'w1',name:'write',arguments:JSON.stringify({path:'blocked.txt',content:'hello'})}]
                : [{type:'message',role:'assistant',content:[{type:'output_text',text:'未写入'}]}];
            if (count > 1) yield {type:'response.output_text.delta',output_index:0,content_index:0,delta:'未写入'};
            yield {type:'response.completed',response:{status:'completed',output}};
        })()}};
        await main({argv:['--jsonl', process.argv[1]], client});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, root], { cwd: new URL("../", import.meta.url),
        env: { ...process.env, OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_API_KEY: "test-only" }, stdio: ["pipe", "pipe", "pipe"] });
    const output = []; let buffer = ""; let stderr = ""; let parseError;
    child.stdout.on("data", c => {
        buffer += c;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
                const event = JSON.parse(line); output.push(event);
                if (event.type === "approval_requested") child.stdin.write(JSON.stringify({ type: "approve", approvalId: event.approvalId, allow: false }) + "\n");
                if (event.type === "agent_end") child.stdin.write('{"type":"exit"}\n');
            } catch (error) { parseError = error; }
        }
    });
    child.stderr.on("data", c => { stderr += c; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 2500);
    try {
        child.stdin.write('{"type":"prompt","content":"写文件"}\n');
        assert.equal(await done, 0, stderr); assert.equal(parseError, undefined); assert.equal(stderr, "");
        assert.equal(output.find(e => e.type === "approval_resolved").outcome, "rejected");
        assert.equal(output.find(e => e.type === "message_end").text, "未写入");
        assert.equal(output.at(-1).type, "agent_end"); assert.equal(output.at(-1).status, "completed");
        assert.equal(output.some(e => e.type === "tool_start"), false);
        await assert.rejects(access(path.join(root, "blocked.txt")), { code: "ENOENT" });
    } finally { clearTimeout(timer); child.stdin.destroy(); await rm(root, { recursive: true, force: true }); }
});
