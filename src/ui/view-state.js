// 纯状态投影：同一份事件可测试、导出，或由任意界面消费。
export function createViewState() {
    const entries = [];
    const messages = new Map();
    const approvals = new Map();
    const tools = new Set();
    let status = "空闲";
    let queued = 0;
    let cancelling = false;
    function update(event) {
        switch (event.type) {
            case "agent_start": status = "正在运行"; queued = 0; cancelling = false; break;
            case "turn_start": status = "等待模型"; break;
            case "message":
                if (event.kind !== "prompt") queued = Math.max(0, queued - 1);
                entries.push({ kind: "user", text: event.content });
                break;
            case "queued": queued++; break;
            case "message_start": {
                const entry = { kind: "assistant", messageId: event.messageId, text: "", status: "streaming", parts: new Map() };
                messages.set(event.messageId, entry); entries.push(entry); break;
            }
            case "text_delta": {
                const entry = messages.get(event.messageId);
                if (!entry) break;
                entry.parts.set(event.partIndex, (entry.parts.get(event.partIndex) ?? "") + event.delta);
                entry.text = [...entry.parts].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
                status = "正在生成"; break;
            }
            case "message_end": {
                const entry = messages.get(event.messageId);
                if (entry) { entry.text = event.text; entry.status = event.status; entry.parts.clear(); }
                status = "正在运行"; break;
            }
            case "answer": entries.push({ kind: "assistant", text: event.text, status: "completed" }); break;
            case "approval_requested": approvals.set(event.approvalId, event); status = "等待审批"; break;
            case "approval_resolved":
                approvals.delete(event.approvalId);
                entries.push({ kind: "notice", text: `审批 ${event.approvalId}：${event.outcome} · ${event.reason}` });
                status = "正在运行"; break;
            case "tool_start": tools.add(event.callId); status = `执行 ${event.name}`; break;
            case "tool_end": case "tool_skipped":
                tools.delete(event.callId);
                entries.push({ kind: "notice", text: `${event.name}：${event.result?.error?.code ?? (event.result?.cancelled ? "cancelled" : "完成")} (${event.callId})` });
                status = tools.size ? "执行工具" : "正在运行"; break;
            case "cancel_requested": cancelling = true; break;
            case "agent_end":
                status = `任务结束：${event.status}`; queued = 0; cancelling = false; tools.clear(); approvals.clear();
                if (event.error) entries.push({ kind: "notice", text: event.error });
                break;
        }
    }
    return {
        update,
        notice(text) { entries.push({ kind: "notice", text }); },
        snapshot() { return structuredClone({ entries, approvals: [...approvals.values()], status: cancelling ? "正在取消，等待底层结束" : status, queued }); },
    };
}
