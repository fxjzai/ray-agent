// 第六篇准备版：只验证会话调度，不连接供应商协议或真实 Shell。
// runTurn / executeTool 必须协作处理 AbortSignal；不会强制终止忽略信号的操作。
export function createSession({ runTurn, executeTool, onEvent = () => {}, maxTurns = 8 }) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns 必须是正整数");
    let controller;
    let running = false;
    let finishing = false;
    let messages = [];
    let steering = [];
    let followUps = [];
    let sequence = 0;

    function emit(type, data = {}) {
        // 观察者不能改内部状态或通过抛错中断已经执行的操作。
        try { onEvent(structuredClone({ sequence: ++sequence, type, ...data })); } catch { /* 观察接口 */ }
    }
    function message(value) {
        messages.push(value);
        emit("message", { message: value });
    }
    function enqueue(queue, text, kind) {
        if (!running || finishing || controller.signal.aborted) throw new Error("会话未运行或正在取消");
        if (typeof text !== "string" || !text.trim()) throw new Error("消息不能为空");
        queue.push(text);
        emit("queued", { kind, text });
    }
    function consumeSteering() {
        // 本原型在一个边界消费当前全部插话，保持 FIFO。
        const pending = steering.splice(0);
        for (const text of pending) message({ role: "user", kind: "steer", content: text });
    }
    function skipped(call, code) {
        const result = { error: { code, message: "调用未启动" } };
        message({ role: "tool", toolCallId: call.id, result });
        emit("tool_skipped", { id: call.id, code });
    }

    async function prompt(text) {
        if (running) throw new Error("会话正在运行，请使用 steer 或 followUp");
        if (typeof text !== "string" || !text.trim()) throw new Error("消息不能为空");
        running = true;
        finishing = false;
        controller = new AbortController();
        messages = [];
        steering = [];
        followUps = [];
        sequence = 0;
        const signal = controller.signal;
        let status = "completed";
        let failure;
        let turns = 0;
        emit("agent_start");
        message({ role: "user", kind: "prompt", content: text });
        try {
            while (true) {
                signal.throwIfAborted();
                if (turns >= maxTurns) { status = "max_turns"; break; }
                consumeSteering();
                emit("turn_start", { turn: ++turns });
                let turnStatus = "completed";
                try {
                    signal.throwIfAborted();
                    const response = await runTurn({ messages: structuredClone(messages), signal });
                    signal.throwIfAborted();
                    const calls = response.toolCalls ?? [];
                    if (!Array.isArray(calls) || calls.some((c) => typeof c?.id !== "string") || new Set(calls.map((c) => c.id)).size !== calls.length) {
                        throw new Error("模型适配器必须提供有唯一 id 的 toolCalls 数组");
                    }
                    message({ role: "assistant", content: response.text ?? "", toolCalls: calls });
                    // 为看清插话检查点，原型先串行；正式接入时再保留 lesson-04 的并行批次策略。
                    for (let index = 0; index < calls.length; index++) {
                        const call = calls[index];
                        if (signal.aborted || steering.length > 0) {
                            const code = signal.aborted ? "CANCELLED" : "STEERING_SKIPPED";
                            for (const pending of calls.slice(index)) skipped(pending, code);
                            break;
                        }
                        emit("tool_start", { id: call.id, name: call.name });
                        let result;
                        try {
                            signal.throwIfAborted();
                            result = await executeTool(structuredClone(call), { signal });
                        } catch (error) {
                            result = { error: { code: signal.aborted ? "CANCELLED" : "TOOL_FAILED", message: String(error.message ?? error) } };
                        }
                        // 工具若已经成功，取消不应把它伪装成“没有执行”。
                        message({ role: "tool", toolCallId: call.id, result });
                        emit("tool_end", { id: call.id, result });
                    }
                    signal.throwIfAborted();
                    if (calls.length > 0 || steering.length > 0) continue;
                } catch (error) {
                    turnStatus = signal.aborted ? "cancelled" : "error";
                    throw error;
                } finally {
                    emit("turn_end", { turn: turns, status: turnStatus });
                }
                // 同步观察者也可能在 turn_end 入队，必须在判断空闲前重查插话。
                signal.throwIfAborted();
                if (steering.length > 0) continue;
                if (followUps.length > 0) {
                    if (turns >= maxTurns) { status = "max_turns"; break; }
                    message({ role: "user", kind: "follow_up", content: followUps.shift() });
                    continue;
                }
                break;
            }
        } catch (error) {
            status = signal.aborted ? "cancelled" : "error";
            failure = String(error.message ?? error);
        } finally {
            const discarded = { steering: steering.length, followUps: followUps.length };
            steering = [];
            followUps = [];
            finishing = true;
            emit("agent_end", { status, turns, discarded, ...(failure ? { error: failure } : {}) });
            running = false;
        }
        return { status, turns, messages: structuredClone(messages), ...(failure ? { error: failure } : {}) };
    }

    return {
        prompt,
        steer: (text) => enqueue(steering, text, "steer"),
        followUp: (text) => enqueue(followUps, text, "follow_up"),
        abort: () => { if (running && !finishing && !controller.signal.aborted) { controller.abort(); emit("cancel_requested"); } },
        get running() { return running; },
    };
}
