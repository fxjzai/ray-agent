import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "../src/runtime/tool-registry.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";

const definition = (name = "read") => ({
    type: "function", name, description: "测试工具",
    parameters: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 } },
        required: ["path"], additionalProperties: false,
    },
});
const call = (name = "read", args = { path: "demo.txt" }, id = name) => ({
    type: "function_call", name, arguments: JSON.stringify(args), call_id: id,
});
const body = (output) => JSON.parse(output.output);
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};

test("Registry 统一导出定义，默认串行且需要审批，拒绝重复注册", () => {
    const registry = new ToolRegistry();
    const toolDefinition = definition();
    assert.equal(registry.register({ definition: toolDefinition, execute: () => ({ ok: true }) }), registry);
    assert.deepEqual(registry.definitions(), [toolDefinition]);
    assert.equal(registry.get("read").executionMode, "sequential");
    assert.equal(registry.get("read").requiresApproval, true);
    assert.throws(() => registry.register({ definition: toolDefinition, execute() {} }), /重复注册/);
    assert.equal(registry.get("missing"), undefined);
});

test("Registry 在注册时拒绝无效策略、执行函数和 Schema", () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ definition: definition(), execute() {}, executionMode: "auto" }), /策略无效/);
    assert.throws(() => registry.register({ definition: definition() }), /执行函数/);
    assert.throws(() => registry.register({ definition: { ...definition(), parameters: { type: "not-a-type" } }, execute() {} }));
});

test("未知工具返回结构化错误，并且仍然审计一次", async () => {
    const events = [];
    const executor = createToolExecutor({ registry: new ToolRegistry(), afterToolCall: (event) => events.push(event) });
    const output = await executor.executeToolCall(call("missing"));
    assert.equal(output.type, "function_call_output");
    assert.equal(output.call_id, "missing");
    assert.equal(body(output).error.code, "UNKNOWN_TOOL");
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, undefined);
    assert.ok(events[0].durationMs >= 0);
});

test("非法 JSON、缺参数、类型错误、额外参数和边界值在执行与审批前被拦截", async () => {
    let executed = 0;
    let before = 0;
    const events = [];
    const registry = new ToolRegistry().register({ definition: definition(), execute: () => { executed++; }, requiresApproval: false });
    const executor = createToolExecutor({ registry, beforeToolCall: () => { before++; }, afterToolCall: (event) => events.push(event) });
    const calls = [
        { ...call(), arguments: "{" },
        call("read", {}), call("read", { path: 3 }), call("read", { path: "a", extra: true }),
        call("read", { path: "a", offset: "1" }), call("read", { path: "a", offset: 0 }), call("read", null),
    ];
    for (const [index, toolCall] of calls.entries()) {
        const output = await executor.executeToolCall(toolCall);
        assert.equal(body(output).error.code, index === 0 ? "INVALID_JSON" : "INVALID_ARGUMENTS");
    }
    assert.equal(executed, 0);
    assert.equal(before, 0);
    assert.equal(events.length, calls.length);
    assert.deepEqual(events[3].args, { path: "a", extra: true });
    assert.equal(events[4].args.offset, "1");
});

test("合法参数原样传给工具，并保持结果 shape、call_id 和审计信息", async () => {
    const events = [];
    const registry = new ToolRegistry().register({
        definition: definition(), requiresApproval: false,
        execute: (args, root) => { assert.deepEqual(args, { path: "demo.txt" }); assert.equal(root, "/workspace"); return { content: "1: hello", lineCount: 1 }; },
    });
    const executor = createToolExecutor({ registry, workspaceRoot: "/workspace", afterToolCall: (event) => events.push(event) });
    const output = await executor.executeToolCall(call("read", { path: "demo.txt" }, "call-7"));
    assert.equal(output.call_id, "call-7");
    assert.deepEqual(body(output), { content: "1: hello", lineCount: 1 });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].result, body(output));
    assert.equal(events[0].workspaceRoot, "/workspace");
});

test("需要审批的工具：无 Hook、未明确允许、拒绝和审批异常都不能产生副作用", async () => {
    let executed = 0;
    const registry = new ToolRegistry().register({ definition: definition("write"), execute: () => { executed++; return { ok: true }; } });
    const hooks = [undefined, () => undefined, () => ({}), () => ({ allow: "true" }), () => ({ allow: false, reason: "用户拒绝" }), () => { throw new Error("approval unavailable"); }];
    for (const beforeToolCall of hooks) {
        const events = [];
        const executor = createToolExecutor({ registry, beforeToolCall, afterToolCall: (event) => events.push(event) });
        assert.equal(body(await executor.executeToolCall(call("write"))).error.code, "TOOL_DENIED");
        assert.equal(events.length, 1);
    }
    assert.equal(executed, 0);
    const approved = createToolExecutor({ registry, beforeToolCall: () => ({ allow: true }) });
    assert.deepEqual(body(await approved.executeToolCall(call("write"))), { ok: true });
    assert.equal(executed, 1);
});

test("无需审批的工具仍遵守 Before Hook 拒绝和异常，undefined 则放行", async () => {
    let executed = 0;
    const registry = new ToolRegistry().register({ definition: definition(), requiresApproval: false, execute: () => { executed++; return { ok: true }; } });
    for (const beforeToolCall of [() => ({ allow: false, reason: "blocked" }), () => { throw new Error("check failed"); }]) {
        const executor = createToolExecutor({ registry, beforeToolCall });
        assert.equal(body(await executor.executeToolCall(call())).error.code, "TOOL_DENIED");
    }
    assert.equal(executed, 0);
    const executor = createToolExecutor({ registry, beforeToolCall: () => undefined });
    assert.deepEqual(body(await executor.executeToolCall(call())), { ok: true });
    assert.equal(executed, 1);
});

test("执行异常返回结构化失败且 After Hook 恰好观察一次", async () => {
    const events = [];
    const registry = new ToolRegistry().register({ definition: definition(), requiresApproval: false, execute: () => { throw new Error("file unavailable"); } });
    const executor = createToolExecutor({ registry, afterToolCall: (event) => events.push(event) });
    assert.deepEqual(body(await executor.executeToolCall(call())), { error: { code: "TOOL_EXECUTION_FAILED", message: "file unavailable" } });
    assert.equal(events.length, 1);
    assert.equal(events[0].result.error.code, "TOOL_EXECUTION_FAILED");
});

test("After Hook 与诊断 Hook 故障不会把已经成功的副作用变成失败", async () => {
    let effects = 0;
    let after = 0;
    let diagnostic = 0;
    const registry = new ToolRegistry().register({ definition: definition("write"), execute: () => { effects++; return { written: true }; } });
    const executor = createToolExecutor({
        registry, beforeToolCall: () => ({ allow: true }),
        afterToolCall: () => { after++; throw new Error("audit offline"); },
        onHookError: (error, event) => { diagnostic++; assert.equal(error.message, "audit offline"); assert.deepEqual(event.result, { written: true }); throw new Error("logger offline"); },
    });
    assert.deepEqual(body(await executor.executeToolCall(call("write"))), { written: true });
    assert.deepEqual([effects, after, diagnostic], [1, 1, 1]);
});

test("全部只读并行调用同时启动，完成顺序不同也按请求顺序返回", async () => {
    const bothStarted = deferred();
    const releaseFirst = deferred();
    const started = [];
    const finished = [];
    const registry = new ToolRegistry().register({
        definition: definition(), executionMode: "parallel", requiresApproval: false,
        execute: async ({ path }) => {
            started.push(path);
            if (started.length === 2) bothStarted.resolve();
            await bothStarted.promise;
            if (path === "first") await releaseFirst.promise;
            else releaseFirst.resolve();
            finished.push(path);
            return { path };
        },
    });
    const executor = createToolExecutor({ registry });
    const outputs = await executor.executeToolCalls([call("read", { path: "first" }, "1"), call("read", { path: "second" }, "2")]);
    assert.deepEqual(finished, ["second", "first"]);
    assert.deepEqual(outputs.map((output) => output.call_id), ["1", "2"]);
    assert.deepEqual(outputs.map(body), [{ path: "first" }, { path: "second" }]);
});

test("混合批次全串行，后续读取看到写入后的状态", async () => {
    let state = "old";
    const events = [];
    const registry = new ToolRegistry()
        .register({ definition: definition(), executionMode: "parallel", requiresApproval: false, execute: async () => { events.push(`read:${state}`); return { state }; } })
        .register({ definition: definition("write"), execute: async () => { events.push("write:start"); await Promise.resolve(); state = "new"; events.push("write:end"); return { state }; } });
    const executor = createToolExecutor({ registry, beforeToolCall: () => ({ allow: true }) });
    const outputs = await executor.executeToolCalls([call(), call("write"), call()]);
    assert.deepEqual(events, ["read:old", "write:start", "write:end", "read:new"]);
    assert.deepEqual(outputs.map(body), [{ state: "old" }, { state: "new" }, { state: "new" }]);
});

test("即使标记 parallel，需要审批的调用也不会同时打开审批", async () => {
    const events = [];
    const registry = new ToolRegistry().register({ definition: definition("write"), executionMode: "parallel", execute: ({ path }) => { events.push(`execute:${path}`); return { path }; } });
    const executor = createToolExecutor({ registry, beforeToolCall: async ({ args }) => { events.push(`approve:${args.path}`); await Promise.resolve(); return { allow: true }; } });
    await executor.executeToolCalls([call("write", { path: "a" }), call("write", { path: "b" })]);
    assert.deepEqual(events, ["approve:a", "execute:a", "approve:b", "execute:b"]);
});
