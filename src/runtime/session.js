import { randomUUID } from "node:crypto";
import { createApprovalBroker } from "./approval-broker.js";

// 第三篇的内层工具循环 + 外层后续消息循环。输入接收由 CLI 独立负责。
export function createAgentSession({ runTurn, executor, onEvent = () => {}, maxTurns = 8 }) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns 必须是正整数");
    const history = [];
    let controller;
    let running = false;
    let finishing = false;
    let steering = [];
    let followUps = [];
    let sequence = 0;
    let runId;
    let turn = 0;
    const approvals = createApprovalBroker({ onEvent: (event) => emit(event.type, event) });

    function emit(type, data = {}) {
        try {
            const result = onEvent(structuredClone({ ...data, type, runId, turn, sequence: ++sequence }));
            Promise.resolve(result).catch(() => {});
        } catch { /* 观察者隔离；不等待异步订阅者 */ }
    }
    function addUser(content, kind) {
        history.push({ role: "user", content });
        emit("message", { kind, content });
    }
    function enqueue(queue, content, kind) {
        if (!running || finishing || controller.signal.aborted) throw new Error("会话未运行或正在收尾");
        if (typeof content !== "string" || !content.trim()) throw new Error("消息不能为空");
        queue.push(content);
        // 先保存 Steering，再撤销审批；界面完全不订阅也能正确跳过调用。
        if (kind === "steer") approvals.invalidate("用户已插话，请重新判断");
        emit("queued", { kind, content });
    }

    async function prompt(content) {
        if (running) throw new Error("运行中请使用 /steer 或 /follow");
        if (typeof content !== "string" || !content.trim()) throw new Error("消息不能为空");
        running = true;
        finishing = false;
        controller = new AbortController();
        runId = randomUUID();
        sequence = 0;
        turn = 0;
        const { signal } = controller;
        let status = "completed";
        let turns = 0;
        let error;
        let text = "";
        emit("agent_start");
        addUser(content, "prompt");
        try {
            // 外层：当前任务结束后，才取一条 Follow-up。
            outer: while (true) {
                // 内层：工具结果或 Steering 让当前任务继续。
                while (true) {
                    signal.throwIfAborted();
                    if (turns >= maxTurns) { status = "max_turns"; break outer; }
                    for (const pending of steering.splice(0)) addUser(pending, "steer");
                    turn = ++turns;
                    emit("turn_start");
                    let turnStatus = "completed";
                    let calls;
                    try {
                        signal.throwIfAborted();
                        let streamed = false;
                        const response = await runTurn({ input: structuredClone(history), signal,
                            onEvent(event) {
                                streamed = true;
                                emit(event.type, { ...event, messageId: `${runId}:${turn}:${event.messageId}` });
                            },
                        });
                        // 取消期间收到但尚未采用的响应不加入历史，也不执行其调用。
                        signal.throwIfAborted();
                        history.push(...structuredClone(response.output));
                        calls = response.calls;
                        text = response.text;
                        if (text && !streamed) emit("answer", { text });
                        const results = await executor.executeToolCalls(calls, {
                            signal,
                            shouldSkip: () => steering.length > 0,
                            onToolEvent: (event) => emit(event.type, { ...event, callId: event.call_id }),
                        });
                        // 先补齐本批全部 call_id，再接收下一条用户消息。
                        history.push(...results);
                        signal.throwIfAborted();
                    } catch (cause) {
                        turnStatus = signal.aborted ? "cancelled" : "error";
                        throw cause;
                    } finally {
                        emit("turn_end", { turn: turns, status: turnStatus });
                    }
                    signal.throwIfAborted();
                    // 观察者在 turn_end 入队的消息也需要检查。
                    if (calls.length > 0 || steering.length > 0) continue;
                    break;
                }
                if (!followUps.length) break;
                if (turns >= maxTurns) { status = "max_turns"; break; }
                addUser(followUps.shift(), "follow_up");
            }
        } catch (cause) {
            status = signal.aborted ? "cancelled" : "error";
            error = String(cause.message ?? cause);
        } finally {
            finishing = true;
            approvals.invalidate("任务已结束");
            const discarded = { steering: steering.length, followUps: followUps.length };
            steering = [];
            followUps = [];
            emit("agent_end", { status, turns, discarded, ...(error ? { error } : {}) });
            running = false;
        }
        return { runId, status, turns, text, ...(error ? { error } : {}) };
    }

    return {
        prompt,
        steer: (content) => enqueue(steering, content, "steer"),
        followUp: (content) => enqueue(followUps, content, "follow_up"),
        requestApproval(event) {
            if (!running || finishing) return { allow: false, reason: "会话未运行或正在收尾" };
            return approvals.request({ ...event, signal: controller.signal });
        },
        approve: (decision) => approvals.resolve(decision),
        get pendingApprovals() { return approvals.size; },
        abort() {
            if (running && !finishing && !controller.signal.aborted) {
                controller.abort();
                emit("cancel_requested");
            }
        },
        get running() { return running; },
        get runId() { return runId; },
        get history() { return structuredClone(history); },
    };
}
