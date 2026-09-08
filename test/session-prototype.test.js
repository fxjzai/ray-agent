import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../experiments/lesson-05/session.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tool = (id) => ({ id, name: "fake", args: {} });

test("插话在工具边界生效，未启动工具补齐跳过结果，追加任务最后消费", async () => {
    const entered = deferred(); const release = deferred(); const inputs = []; const executed = []; const events = [];
    const session = createSession({
        onEvent: (e) => events.push(e),
        runTurn: async ({ messages }) => { inputs.push(messages); return inputs.length === 1 ? { toolCalls: [tool("a"), tool("b")] } : { text: "done" }; },
        executeTool: async (call) => { executed.push(call.id); entered.resolve(); await release.promise; return { ok: true }; },
    });
    const run = session.prompt("检查项目");
    await entered.promise;
    session.followUp("最后给一份说明");
    session.steer("先别修改");
    release.resolve();
    const result = await run;
    assert.equal(result.status, "completed");
    assert.deepEqual(executed, ["a"]);
    assert.deepEqual(inputs[1].filter((m) => m.role === "tool").map((m) => m.toolCallId), ["a", "b"]);
    assert.equal(inputs[1].find((m) => m.toolCallId === "b").result.error.code, "STEERING_SKIPPED");
    assert.equal(inputs[1].at(-1).kind, "steer");
    assert.equal(inputs[2].at(-1).kind, "follow_up");
    assert.equal(events.filter((e) => e.type === "agent_end").length, 1);
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
});

test("取消传递给正在等待的模型，收尾且不消费排队任务", async () => {
    const entered = deferred(); let observedSignal;
    const events = [];
    const session = createSession({ onEvent: (e) => events.push(e), runTurn: ({ signal }) => {
        observedSignal = signal; entered.resolve();
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const run = session.prompt("等待模型"); await entered.promise;
    session.followUp("不应该执行"); session.abort();
    const result = await run;
    assert.equal(observedSignal.aborted, true);
    assert.equal(result.status, "cancelled");
    assert.equal(session.running, false);
    assert.equal(events.at(-1).discarded.followUps, 1);
    assert.equal(events.filter((e) => e.type === "turn_end").length, 1);
});

test("取消正在执行的工具，为后续工具补齐 CANCELLED，并允许新任务", async () => {
    const entered = deferred(); let turns = 0;
    const session = createSession({
        runTurn: async () => ++turns === 1 ? { toolCalls: [tool("a"), tool("b")] } : { text: "new task" },
        executeTool: (call, { signal }) => { entered.resolve(); return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
    });
    const run = session.prompt("执行任务"); await entered.promise; session.abort();
    const result = await run;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.messages.filter((m) => m.role === "tool").map((m) => m.result.error.code), ["CANCELLED", "CANCELLED"]);
    assert.equal((await session.prompt("新任务")).status, "completed");
});

test("工具忽略取消时等待真实结果，不能宣称副作用未发生", async () => {
    const entered = deferred(); const release = deferred();
    const session = createSession({ runTurn: async () => ({ toolCalls: [tool("a")] }), executeTool: async () => { entered.resolve(); await release.promise; return { written: true }; } });
    const run = session.prompt("任务"); await entered.promise; session.abort();
    assert.equal(session.running, true);
    release.resolve(); const result = await run;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.messages.at(-1).result, { written: true });
});

test("执行错误回填，观察者抛错不破坏会话", async () => {
    let n = 0;
    const session = createSession({ onEvent: () => { throw new Error("observer"); }, runTurn: async () => ++n === 1 ? { toolCalls: [tool("a")] } : { text: "done" }, executeTool: async () => { throw new Error("failed"); } });
    const result = await session.prompt("任务");
    assert.equal(result.status, "completed");
    assert.equal(result.messages.find((m) => m.role === "tool").result.error.code, "TOOL_FAILED");
});

test("轮数预算覆盖追加任务，重复 prompt 拒绝，空闲不能插话", async () => {
    const release = deferred();
    const session = createSession({ maxTurns: 1, runTurn: async () => { await release.promise; return { text: "done" }; } });
    assert.throws(() => session.steer("x"), /未运行/);
    const run = session.prompt("任务");
    await assert.rejects(session.prompt("另一个任务"), /正在运行/);
    session.followUp("追加"); release.resolve();
    assert.equal((await run).status, "max_turns");
});

test("最终 turn_end 到达的插话优先于 Follow-up，不会被遗漏", async () => {
    const inputs = []; let session;
    session = createSession({ runTurn: async ({ messages }) => { inputs.push(messages); return { text: "done" }; }, onEvent: (e) => { if (e.type === "turn_end" && e.turn === 1) { session.followUp("后续"); session.steer("插话"); } } });
    const result = await session.prompt("任务");
    assert.equal(result.turns, 3);
    assert.equal(inputs[1].at(-1).kind, "steer");
    assert.equal(inputs[2].at(-1).kind, "follow_up");
});

test("agent_end 观察者不能重入 prompt 并覆盖已完成任务的历史", async () => {
    let session; let reentry; const events = [];
    session = createSession({ runTurn: async () => ({ text: "original" }), onEvent: (e) => {
        events.push(e.type);
        if (e.type === "agent_end") {
            session.abort();
            assert.throws(() => session.followUp("late"), /未运行/);
            reentry = session.prompt("reentry").catch((error) => error.message);
        }
    } });
    const result = await session.prompt("任务");
    assert.equal(result.messages.at(-1).content, "original");
    assert.match(await reentry, /正在运行/);
    assert.equal(events.at(-1), "agent_end");
});
