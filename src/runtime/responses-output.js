// 完整响应才进入历史；增量从不作为可执行的工具参数。
export function parseResponsesOutput(response, input) {
    if (response?.status !== "completed") throw new Error(`模型响应未完成：${response?.status ?? "缺少 status"}`);
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
    const text = output.filter((item) => item.type === "message").map(messageText).join("");
    if (!calls.length && !text) throw new Error("模型响应既无工具调用，也无回答文本");
    return { output, calls, text };
}

export function messageText(item) {
    return (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("");
}
