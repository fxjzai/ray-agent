// 结构化控制入口；CLI/JSONL 只负责解析，不管理审批或消息调度。
export function createAgentController(session) {
    let active;
    let closed = false;
    function dispatch(command) {
        if (closed) throw new Error("输入已关闭");
        if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("命令必须是对象");
        const { type, content } = command;
        if (["prompt", "steer", "follow_up"].includes(type) && (typeof content !== "string" || !content.trim())) {
            throw new Error("消息不能为空");
        }
        switch (type) {
            case "prompt":
                if (session.running) throw new Error("正在运行：请使用 steer 或 follow_up");
                active = session.prompt(content);
                break;
            case "steer": session.steer(content); break;
            case "follow_up": session.followUp(content); break;
            case "approve": session.approve(command); break;
            case "cancel": session.abort(); break;
            case "exit": close(); break;
            default: throw new Error(`未知命令：${String(type)}`);
        }
        return { accepted: true, runId: session.runId };
    }
    function close() { if (!closed) { closed = true; session.abort(); } }
    return { dispatch, close, get closed() { return closed; }, async wait() { return active; } };
}
