// CLI 和可复现演示共用同一个 Loop；客户端由入口传入。
export function createAgent({ client, model, workspaceRoot, tools, executor }) {
    const context = [];
    return async function runAgent(userInput, maxTurns = 8) {
        context.push({ role: "user", content: userInput });
        for (let turn = 1; turn <= maxTurns; turn++) {
            const response = await client.responses.create({
                model,
                instructions: [
                    "你是 Coding Agent，可以读取、创建、精确修改文件，并运行命令验证结果。",
                    `当前工作区是 ${workspaceRoot}。文件工具只能访问该目录；bash 的 cwd 虽固定在这里，但它不是安全沙箱。`,
                    "修改前先读取相关文件，修改后运行测试，并根据真实结果回答。",
                    "write、edit、bash 需要逐次审批。若结果为 TOOL_DENIED，停止该操作并解释，不要重试或换工具绕过。",
                ].join("\n"),
                tools,
                input: context,
            });
            // 必须保留完整 output，包括 reasoning 和 function_call Items。
            context.push(...response.output);
            const toolCalls = response.output.filter((item) => item.type === "function_call");
            if (toolCalls.length === 0) return response.output_text;
            context.push(...await executor.executeToolCalls(toolCalls));
        }
        throw new Error(`Agent 超过最大执行轮数：${maxTurns}`);
    };
}
