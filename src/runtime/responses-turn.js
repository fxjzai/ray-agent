// 保留供应商 Items，不把 reasoning 压成文本或 UI 事件。
export function createResponsesTurn({ client, model, workspaceRoot, tools }) {
    return async ({ input, signal }) => {
        const response = await client.responses.create({
            model,
            instructions: [
                "你是 Coding Agent，可以读取、创建、精确修改文件，并运行命令验证结果。",
                `当前工作区是 ${workspaceRoot}。文件工具只能访问该目录；bash 的 cwd 限制不是安全沙箱。`,
                "修改前先读取，修改后用真实测试验证。write、edit、bash 需要逐次审批。",
                "TOOL_DENIED 表示拒绝，不要重试或换工具绕过。STEERING_SKIPPED 表示调用未启动，请按随后用户的新要求重新判断。",
                "CANCELLED 表示取消，已发生的副作用不会回滚。只依据实际工具结果报告。",
            ].join("\n"),
            tools,
            input,
        }, { signal });
        if (response.status !== "completed") throw new Error(`模型响应未完成：${response.status ?? "缺少 status"}`);
        if (!Array.isArray(response.output) || response.output.length === 0) throw new Error("模型响应缺少 output Items");
        const output = structuredClone(response.output);
        const calls = output.filter((item) => item.type === "function_call");
        const priorIds = new Set(input.filter((item) => item.type === "function_call").map((item) => item.call_id));
        for (const call of calls) {
            if (typeof call.call_id !== "string" || !call.call_id || priorIds.has(call.call_id) ||
                typeof call.name !== "string" || !call.name || typeof call.arguments !== "string") {
                throw new Error("模型工具调用缺少有效字段或 call_id 重复");
            }
            priorIds.add(call.call_id);
        }
        if (output.some((item) => item.type === "custom_tool_call")) throw new Error("本课未注册 custom 工具");
        const text = output.filter((item) => item.type === "message")
            .flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text")
            .map((part) => part.text).join("");
        if (!calls.length && !text) throw new Error("模型响应既无工具调用，也无回答文本");
        return { output, calls, text };
    };
}
