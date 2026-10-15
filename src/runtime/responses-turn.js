import { parseResponsesOutput } from "./responses-output.js";
import { consumeResponsesStream } from "./responses-stream.js";

// 默认保留 lesson-05 非流式行为；新入口显式打开 stream。
export function createResponsesTurn({ client, model, workspaceRoot, tools, stream = false }) {
    return async ({ input, signal, onEvent }) => {
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
            ...(stream ? { stream: true } : {}),
        }, { signal });
        return stream ? consumeResponsesStream(response, { input, signal, onEvent }) : parseResponsesOutput(response, input);
    };
}
