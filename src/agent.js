// dotenv/config 会在程序启动时读取根目录的 .env 文件。
// 这样 API Key 不需要直接写进源码，也就不会误提交到 Git。
import "dotenv/config";

// OpenAI 是官方 JavaScript SDK。
// 即使使用兼容 OpenAI 接口的服务，也可以继续使用这个客户端。
import OpenAI from "openai";

// readline/promises 用来在终端中等待用户输入。
// promises 版本可以配合 await 使用，比回调形式更容易阅读。
import readline from "node:readline/promises";
import path from "node:path";

import { bashTool, runBash } from "./tools/bash.js";
import { editTextFile, editTool } from "./tools/edit.js";
import { readTextFile, readTool } from "./tools/read.js";
import { writeTextFile, writeTool } from "./tools/write.js";

// SDK 会自动读取 OPENAI_API_KEY 和 OPENAI_BASE_URL。
const client = new OpenAI();

// 模型名也放在 .env 中，方便读者切换自己的服务。
// 如果没有配置 MODEL_NAME，就使用 DeepSeek Responses API 当前支持的模型。
const model = process.env.MODEL_NAME || "deepseek-v4-flash";

// 第一个命令行参数可以指定 Agent 操作的工作区，默认使用启动命令所在目录。
const workspaceRoot = path.resolve(process.argv[2] || process.cwd());

// 四个基础工具构成最小 Coding Agent 的动作空间。
// 模型只能看到这些说明，看不到本地函数的内部实现。
const tools = [readTool, writeTool, editTool, bashTool];

// context 保存整个对话期间的完整历史。
// 外层用户消息和内层工具调用产生的 Item 都会进入这个数组。
const context = [];

// 创建终端输入输出接口。
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// 这里故意保留显式路由，下一课再解决工具增多后的注册和统一管理问题。
async function callFunction(name, args) {
    switch (name) {
        case "read":
            return readTextFile(args, workspaceRoot);
        case "write":
            return writeTextFile(args, workspaceRoot);
        case "edit":
            return editTextFile(args, workspaceRoot);
        case "bash":
            return runBash(args, workspaceRoot);
        default:
            throw new Error(`未知工具：${name}`);
    }
}

function describeToolCall(name, args) {
    if (name === "bash") {
        const command = String(args.command ?? "").replaceAll(/\s+/g, " ").slice(0, 120);
        return command.length === 120 ? `${command}…` : command;
    }
    return String(args.path ?? "");
}

function describeToolResult(name, result) {
    if (name === "bash") {
        return result.timedOut ? "超时" : `exitCode=${result.exitCode}`;
    }
    if (name === "read") {
        return `${result.lineCount} 行${result.nextOffset ? `，下一段 offset=${result.nextOffset}` : ""}`;
    }
    return result.message || "完成";
}

// 执行模型返回的一次 Tool Call，并组装成 Responses API 要求的 Tool Result。
async function executeToolCall(toolCall) {
    try {
        // arguments 是模型生成的 JSON 字符串，需要先解析成 JavaScript 对象。
        const args = JSON.parse(toolCall.arguments);
        console.log(`→ ${toolCall.name}  ${describeToolCall(toolCall.name, args)}`);

        // 模型只负责提出调用请求，真正的函数由我们的应用在本地执行。
        const result = await callFunction(toolCall.name, args);
        console.log(`← ${toolCall.name}  ${describeToolResult(toolCall.name, result)}`);

        // call_id 用来告诉模型：这个结果属于刚才的哪一次工具调用。
        return {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: JSON.stringify(result),
        };
    } catch (error) {
        // 单个工具失败不一定要终止整个 Agent。
        // 把错误作为结构化结果回传，模型可以重试、换参数或向用户解释。
        const message = error instanceof Error ? error.message : String(error);
        console.log(`← ${toolCall.name}  失败：${message}`);
        return {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: JSON.stringify({
                error: message,
            }),
        };
    }
}

// 内层 Agent Loop：反复执行“模型 → 工具 → 模型”，直到得到最终回答。
async function runAgent(userInput, maxTurns = 8) {
    // 当前用户消息加入共享 context。
    // 因为 context 定义在函数外，所以前面的多轮对话也仍然保留着。
    context.push({
        role: "user",
        content: userInput,
    });

    // 一次用户任务最多调用模型 maxTurns 次，防止异常情况下无限循环。
    for (let turn = 1; turn <= maxTurns; turn++) {
        const response = await client.responses.create({
            model,
            instructions: [
                "你是 Coding Agent，可以读取、创建、精确修改文件，并运行命令验证结果。",
                `当前工作区是 ${workspaceRoot}。文件工具只能访问该目录；bash 的 cwd 虽固定在这里，但它不是安全沙箱。`,
                "修改代码前先读取相关文件，修改后尽量运行测试或检查命令，并根据真实结果回答。",
            ].join("\n"),
            tools,
            input: context,
        });

        // 必须保存这一轮的完整 output。
        // 其中可能同时包含 reasoning、message 和 function_call 等 Item。
        context.push(...response.output);

        // find 只能得到第一个调用；filter 才能收集模型这一轮的全部调用。
        const toolCalls = response.output.filter(
            (item) => item.type === "function_call"
        );

        // 没有 Tool Call，说明模型已经生成最终自然语言回答，内层循环结束。
        if (toolCalls.length === 0) {
            return response.output_text;
        }

        // 写文件和 Bash 可能依赖前一个调用的副作用，本课先统一串行执行。
        // 下一课再通过工具元数据决定哪些只读调用可以安全并行。
        const toolOutputs = [];
        for (const toolCall of toolCalls) {
            toolOutputs.push(await executeToolCall(toolCall));
        }

        // 工具结果进入 context 后，下一轮模型才能观察结果并继续决策。
        context.push(...toolOutputs);
    }

    // 到达这里说明模型连续多轮都没有结束任务，主动停止以保护时间和费用预算。
    throw new Error(`Agent 超过最大执行轮数：${maxTurns}`);
}

// 外层对话循环：一次处理一条用户消息，任务完成后再等待下一条消息。
console.log(`工作区：${workspaceRoot}\n`);

while (true) {
    const userInput = (await rl.question("你: ")).trim();

    // 提供几种常见退出方式，避免只能用 Ctrl+C 强制结束程序。
    if (["退出", "exit", "quit"].includes(userInput.toLowerCase())) {
        break;
    }

    // 空输入没有实际内容，直接进入下一轮等待。
    if (!userInput) {
        continue;
    }

    try {
        // runAgent 内部可能调用零次、一次或多次工具，外层只等待最终答案。
        const answer = await runAgent(userInput);
        console.log(`AI: ${answer}\n`);
    } catch (error) {
        // 模型请求失败或达到最大轮数时，在这里统一显示错误。
        const message = error instanceof Error ? error.message : String(error);
        console.error(`运行失败：${message}\n`);
    }
}

// 退出外层循环后关闭 readline，让 Node.js 进程正常结束。
rl.close();
