export function parseTerminalCommand(value) {
    const line = value.trim();
    if (!line) return;
    if (["/exit", "exit", "quit", "退出"].includes(line)) return { type: "exit" };
    if (line === "/cancel") return { type: "cancel" };
    const approval = /^\/approve\s+(a\d+)\s+(y|yes|n|no)$/i.exec(line);
    if (approval) return { type: "approve", approvalId: approval[1], allow: /^(y|yes)$/i.test(approval[2]) };
    const message = /^\/(steer|follow)\s+([\s\S]+)$/.exec(line);
    if (message) return { type: message[1] === "steer" ? "steer" : "follow_up", content: message[2] };
    if (line.startsWith("/")) throw new Error("命令：/steer 内容、/follow 内容、/approve a1 y|n、/cancel、/exit");
    return { type: "prompt", content: line };
}
