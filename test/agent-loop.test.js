import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent } from "../src/runtime/agent-loop.js";
import { createCodingToolRegistry } from "../src/runtime/coding-tools.js";
import { createToolExecutor } from "../src/runtime/tool-executor.js";
import { createApprovalHook } from "../src/runtime/approval.js";

test("审批只接受明确的 y/yes，空输入、其他文本和输入异常均拒绝", async () => {
    for (const [answer, expected] of [["y", true], [" YES ", true], ["", false], ["n", false], ["ok", false]]) {
        const hook = createApprovalHook({ question: async () => answer, log: () => {} });
        assert.equal((await hook({ toolCall: { name: "bash" }, args: { command: "npm test" }, tool: { requiresApproval: true } })).allow, expected);
    }
    const hook = createApprovalHook({ question: async () => { throw new Error("closed"); }, log: () => {} });
    assert.equal((await hook({ toolCall: { name: "write" }, args: {}, tool: { requiresApproval: true } })).allow, false);
});

test("审批展示完整编辑内容并转义终端控制字符，只读不提问", async () => {
    const logs = [];
    const args = { path: "a.js", oldText: "x", newText: "a".repeat(150) + "\n\u001b[2J" };
    const hook = createApprovalHook({ question: async () => "n", log: (line) => logs.push(line) });
    await hook({ toolCall: { name: "edit" }, args, tool: { requiresApproval: true } });
    assert.ok(logs[0].includes(JSON.stringify(args)));
    assert.ok(!logs[0].includes("\u001b"));
    const readHook = createApprovalHook({ question: () => assert.fail("read 不应审批"), log: () => {} });
    assert.equal(await readHook({ toolCall: { name: "read" }, args: {}, tool: { requiresApproval: false } }), undefined);
});

test("四工具策略固定在本地，模型只收到 Schema", () => {
    const registry = createCodingToolRegistry();
    assert.equal(registry.get("read").executionMode, "parallel");
    assert.equal(registry.get("read").requiresApproval, false);
    for (const name of ["write", "edit", "bash"]) {
        assert.equal(registry.get(name).executionMode, "sequential");
        assert.equal(registry.get(name).requiresApproval, true);
    }
    assert.ok(registry.definitions().every((tool) => !("requiresApproval" in tool) && !("execute" in tool)));
});

test("审批拒绝经真实执行器回填 call_id，保留 reasoning 后继续得到最终回答", async () => {
    const calls = [];
    const item = { type: "function_call", name: "write", call_id: "call-denied", arguments: '{"path":"denied.txt","content":"no"}' };
    const reasoning = { type: "reasoning", id: "reasoning-1", summary: [] };
    const client = { responses: { create: async (request) => {
        calls.push(structuredClone(request));
        return calls.length === 1 ? { output: [reasoning, item] } : { output: [{ type: "message", content: [] }], output_text: "操作被拒绝，未写入。" };
    } } };
    const registry = createCodingToolRegistry();
    const executor = createToolExecutor({ registry, workspaceRoot: "/unused", beforeToolCall: async () => ({ allow: false, reason: "测试拒绝" }) });
    const run = createAgent({ client, model: "test", workspaceRoot: "/unused", tools: registry.definitions(), executor });
    assert.equal(await run("写入文件"), "操作被拒绝，未写入。");
    assert.deepEqual(calls[1].input[1], reasoning);
    const output = calls[1].input[3];
    assert.equal(output.call_id, "call-denied");
    assert.equal(JSON.parse(output.output).error.code, "TOOL_DENIED");
});

test("持续调用工具时 Loop 按轮数预算停止", async () => {
    let count = 0;
    const client = { responses: { create: async () => { count++; return { output: [{ type: "function_call", call_id: String(count) }] }; } } };
    const run = createAgent({ client, model: "test", tools: [], executor: { executeToolCalls: async () => [] } });
    await assert.rejects(run("loop", 2), /最大执行轮数：2/);
    assert.equal(count, 2);
});
