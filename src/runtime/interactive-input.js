// 一个输入分发器：审批不再调用 rl.question，与聊天抢 stdin。
export function createInteractiveInput({ log = console.log } = {}) {
    let session;
    let active;
    let closed = false;
    let approvalSequence = 0;
    const approvals = new Map();

    function invalidate(reason = "审批已失效") {
        for (const request of [...approvals.values()]) request.finish(false, reason);
    }
    function requestApproval({ toolCall, args, tool, signal }) {
        if (!tool.requiresApproval) return;
        if (closed || signal?.aborted) return { allow: false, reason: "输入已关闭或任务已取消" };
        return new Promise((resolve) => {
            // 本地唯一票号，防止旧批准误命中新调用；同时展示模型的 call_id。
            const ticket = `a${++approvalSequence}`;
            function finish(allow, reason) {
                if (!approvals.delete(ticket)) return;
                signal?.removeEventListener("abort", cancelled);
                log(`审批 ${ticket}：${allow ? "允许" : "未执行"} ${reason ?? ""}`);
                resolve({ allow, reason });
            }
            const cancelled = () => finish(false, "任务已取消");
            approvals.set(ticket, { finish });
            signal?.addEventListener("abort", cancelled, { once: true });
            log(`审批 ${ticket} call_id=${JSON.stringify(toolCall.call_id)} ${toolCall.name} ${JSON.stringify(args)}`);
            log(`输入 /approve ${ticket} y 或 /approve ${ticket} n`);
            if (signal?.aborted) cancelled();
        });
    }
    function handleLine(value) {
        const line = value.trim();
        if (closed || !line) return;
        try {
            if (["/exit", "exit", "quit", "退出"].includes(line)) { close(); return; }
            if (line === "/cancel") { session.abort(); return; }
            if (line.startsWith("/approve")) {
                const match = /^\/approve\s+(a\d+)\s+(y|yes|n|no)$/i.exec(line);
                if (!match) throw new Error("审批格式：/approve a1 y|n；普通 y/n 不会批准");
                const request = approvals.get(match[1]);
                if (!request) throw new Error("审批票号不存在或已经失效");
                const allow = ["y", "yes"].includes(match[2].toLowerCase());
                request.finish(allow, allow ? undefined : "用户拒绝，不要重试或换工具绕过");
                return;
            }
            const command = /^\/(steer|follow)\s+([\s\S]+)$/.exec(line);
            if (command) {
                if (command[1] === "steer") session.steer(command[2]);
                else session.followUp(command[2]);
                return;
            }
            if (line.startsWith("/")) throw new Error("命令：/steer 内容、/follow 内容、/cancel、/approve a1 y|n、/exit");
            if (session.running) throw new Error("正在运行：请明确使用 /steer 或 /follow；审批请带票号");
            active = session.prompt(line);
            // 处理受信任 session 实现意外抛错，避免事件监听器产生未处理 rejection。
            active.catch((error) => log(`任务失败：${error.message}`));
        } catch (error) { log(error.message); }
    }
    function observe(event) {
        if (event.type === "queued" && event.kind === "steer") invalidate("用户已插话，请重新判断");
        if (event.type === "agent_end") invalidate("任务已结束");
    }
    function close() {
        closed = true;
        session?.abort();
        invalidate("输入已关闭");
    }
    return {
        bind(value) { session = value; }, handleLine, requestApproval, observe, close,
        get closed() { return closed; },
        get pendingApprovals() { return approvals.size; },
        async wait() { await active; },
    };
}
