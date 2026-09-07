import { performance } from "node:perf_hooks";

const failure = (code, message) => ({ error: { code, message } });
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function createToolExecutor({ registry, workspaceRoot, beforeToolCall, afterToolCall, onHookError }) {
    async function executeToolCall(toolCall) {
        const startedAt = performance.now();
        const tool = registry.get(toolCall.name);
        let args;
        let result;

        // 校验与审批都在执行函数之前；所有失败也走统一的结果和审计出口。
        if (!tool) {
            result = failure("UNKNOWN_TOOL", `未知工具：${toolCall.name}`);
        } else {
            try {
                args = JSON.parse(toolCall.arguments);
            } catch {
                result = failure("INVALID_JSON", "工具 arguments 必须是合法 JSON");
            }

            if (!result && !tool.validate(args)) {
                const details = tool.validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
                result = failure("INVALID_ARGUMENTS", `工具参数未通过 Schema 校验：${details}`);
            }

            if (!result) {
                try {
                    const decision = await beforeToolCall?.({ toolCall, args, tool, workspaceRoot });
                    if (decision?.allow === false || (tool.requiresApproval && decision?.allow !== true)) {
                        result = failure("TOOL_DENIED", decision?.reason || "工具调用未获批准");
                    }
                } catch (error) {
                    // 审批模块故障时不执行，避免把故障误当作授权。
                    result = failure("TOOL_DENIED", `执行前检查失败：${errorMessage(error)}`);
                }
            }

            if (!result) {
                try {
                    result = await tool.execute(args, workspaceRoot);
                } catch (error) {
                    result = failure("TOOL_EXECUTION_FAILED", errorMessage(error));
                }
            }
        }

        // 工具约定返回 JSON 可序列化的值，提前序列化也避免审计 Hook 修改输出。
        let output;
        try {
            output = JSON.stringify(result);
            if (output === undefined) throw new Error("工具没有返回 JSON 可序列化的结果");
        } catch (error) {
            result = failure("TOOL_EXECUTION_FAILED", `工具结果序列化失败：${errorMessage(error)}`);
            output = JSON.stringify(result);
        }

        const event = { toolCall, args, tool, workspaceRoot, result, durationMs: performance.now() - startedAt };
        try {
            await afterToolCall?.(event);
        } catch (error) {
            // 已经写入的文件不会因日志失败而撤销，不能向模型报告“执行失败”并诱导重试。
            try {
                await onHookError?.(error, event);
            } catch {
                // 诊断出口同样不得改变已经完成的执行结果。
            }
        }

        return { type: "function_call_output", call_id: toolCall.call_id, output };
    }

    async function executeToolCalls(toolCalls) {
        // 只有整批调用都显式允许并行，且不涉及交互审批，才同时启动。
        const canParallel = toolCalls.every((call) => {
            const tool = registry.get(call.name);
            return tool?.executionMode === "parallel" && tool.requiresApproval === false;
        });
        if (canParallel) return Promise.all(toolCalls.map(executeToolCall));

        const outputs = [];
        for (const call of toolCalls) outputs.push(await executeToolCall(call));
        return outputs;
    }

    return { executeToolCall, executeToolCalls };
}
