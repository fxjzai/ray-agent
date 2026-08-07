// dotenv/config 会在程序启动时读取根目录的 .env 文件。
// 这样 API Key 不需要直接写进源码，也就不会误提交到 Git。
import "dotenv/config";

// OpenAI 是官方 JavaScript SDK。
// 即使使用兼容 OpenAI 接口的服务，也可以继续使用这个客户端。
import OpenAI from "openai";

// readline/promises 用来在终端中等待用户输入。
// promises 版本可以配合 await 使用，比回调形式更容易阅读。
import readline from "node:readline/promises";

// weatherTool 是给模型看的工具说明，getWeather 是本地真正执行的函数。
import { getWeather, weatherTool } from "./tools/weather.js";

// SDK 会自动读取 OPENAI_API_KEY 和 OPENAI_BASE_URL。
const client = new OpenAI();

// 模型名也放在 .env 中，方便读者切换自己的服务。
// 如果没有配置 MODEL_NAME，就使用第 2 课文章中的默认模型。
const model = process.env.MODEL_NAME || "deepseek-v4-flash";

// tools 数组会随每一次模型请求发送出去。
// 模型只能看到工具说明，看不到 getWeather 的内部实现。
const tools = [weatherTool];

// context 保存整个对话期间的完整历史。
// 外层用户消息和内层工具调用产生的 Item 都会进入这个数组。
const context = [];

// 创建终端输入输出接口。
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// 根据模型返回的工具名称，找到本地真正需要执行的函数。
// 当前只有一个工具，所以继续保留最直观的 if；后面的课程再做 Tool Registry。
async function callFunction(name, args) {
    if (name === "get_weather") {
        return getWeather(args);
    }

    throw new Error(`未知工具：${name}`);
}

// 执行模型返回的一次 Tool Call，并组装成 Responses API 要求的 Tool Result。
async function executeToolCall(toolCall) {
    try {
        // arguments 是模型生成的 JSON 字符串，需要先解析成 JavaScript 对象。
        const args = JSON.parse(toolCall.arguments);

        // 模型只负责提出调用请求，真正的函数由我们的应用在本地执行。
        const result = await callFunction(toolCall.name, args);

        // call_id 用来告诉模型：这个结果属于刚才的哪一次工具调用。
        return {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: JSON.stringify(result),
        };
    } catch (error) {
        // 单个工具失败不一定要终止整个 Agent。
        // 把错误作为结构化结果回传，模型可以重试、换参数或向用户解释。
        return {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
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
            instructions: "你是天气助手，需要时可以调用天气工具。",
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

        // 当前只有只读天气查询，多个调用彼此没有依赖，也不会修改外部状态，
        // 因此可以使用 Promise.all 并行执行。写文件和 Bash 不能直接照搬此策略。
        const toolOutputs = await Promise.all(
            toolCalls.map(executeToolCall)
        );

        // 工具结果进入 context 后，下一轮模型才能观察结果并继续决策。
        context.push(...toolOutputs);
    }

    // 到达这里说明模型连续多轮都没有结束任务，主动停止以保护时间和费用预算。
    throw new Error(`Agent 超过最大执行轮数：${maxTurns}`);
}

// 外层对话循环：一次处理一条用户消息，任务完成后再等待下一条消息。
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
