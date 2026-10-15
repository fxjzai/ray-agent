// 审批不依赖 stdin、UI 或事件订阅者；事件只通知，resolve 才作决定。
export function createApprovalBroker({ onEvent = () => {} } = {}) {
    const pending = new Map();
    let sequence = 0;
    function emit(event) {
        try { Promise.resolve(onEvent(structuredClone(event))).catch(() => {}); } catch { /* 观察者隔离 */ }
    }
    function request({ toolCall, args, tool, signal }) {
        if (!tool.requiresApproval) return;
        if (signal?.aborted) return { allow: false, reason: "任务已取消" };
        return new Promise((resolve) => {
            const approvalId = `a${++sequence}`;
            function finish(outcome, reason) {
                if (!pending.delete(approvalId)) return;
                signal?.removeEventListener("abort", cancel);
                const allow = outcome === "approved";
                resolve({ allow, reason });
                emit({ type: "approval_resolved", approvalId, callId: toolCall.call_id, outcome, reason });
            }
            const cancel = () => finish("invalidated", "任务已取消");
            pending.set(approvalId, { finish });
            signal?.addEventListener("abort", cancel, { once: true });
            emit({ type: "approval_requested", approvalId, callId: toolCall.call_id, name: toolCall.name, args });
            if (signal?.aborted) cancel();
        });
    }
    return {
        request,
        resolve({ approvalId, allow }) {
            if (typeof allow !== "boolean") throw new Error("allow 必须是布尔值");
            const entry = pending.get(approvalId);
            if (!entry) throw new Error("审批票号不存在或已经失效");
            entry.finish(allow ? "approved" : "rejected", allow ? "用户批准" : "用户拒绝，不要重试或换工具绕过");
        },
        invalidate(reason) {
            for (const entry of [...pending.values()]) entry.finish("invalidated", reason);
        },
        get size() { return pending.size; },
    };
}
