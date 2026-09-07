// JSON 转义控制字符，避免模型给出的换行或 ANSI 转义改变审批展示。
// 审批必须展示完整参数，包括 write 的内容、edit 的原文与新文。
export function createApprovalHook({ question, log = console.log }) {
    return async ({ toolCall, args, tool }) => {
        log(`→ ${toolCall.name}  ${JSON.stringify(args)}`);
        if (!tool.requiresApproval) return;
        try {
            const answer = await question("允许本次调用？[y/N] ");
            const allow = ["y", "yes"].includes(answer.trim().toLowerCase());
            log(`审批：${allow ? "允许" : "拒绝"}`);
            return { allow, reason: allow ? undefined : "用户拒绝本次调用，请停止该操作，不要换工具绕过审批" };
        } catch {
            return { allow: false, reason: "无法读取审批输入，本次调用未执行" };
        }
    };
}

export function logToolResult({ toolCall, result, durationMs }) {
    let summary;
    if (result.error) summary = `${result.error.code}：${result.error.message}`;
    else if (toolCall.name === "bash") summary = result.timedOut ? "超时" : `exitCode=${result.exitCode}`;
    else if (toolCall.name === "read") summary = `${result.lineCount} 行`;
    else summary = result.message || "完成";
    console.log(`← ${toolCall.name}  ${JSON.stringify(summary)} (${Math.round(durationMs)}ms)`);
}
