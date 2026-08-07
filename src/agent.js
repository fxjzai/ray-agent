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
// 如果没有配置 MODEL_NAME，就使用教程当前的默认模型。
const model = process.env.MODEL_NAME || "gpt-5.5";

// tools 数组会随请求一起发送给模型。
// 模型只能看到工具名称、描述和参数结构，看不到 getWeather 的实现代码。
const tools = [weatherTool];

// context 是本次对话的完整历史。
// 它定义在循环外面，所以每次提问后都不会被重新清空。
const context = [];

// 创建终端输入输出接口。
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// 根据模型返回的工具名称，找到本地真正需要执行的函数。
// 当前只有一个工具，所以先使用最直观的 if；后面的课程再优化工具注册方式。
async function callFunction(name, args) {
    if (name === "get_weather") {
        return getWeather(args);
    }

    throw new Error(`未知工具：${name}`);
}

// 向模型发送一条用户消息，并返回模型最终生成的文字。
async function getAssistantReply(userInput) {
    // 先把用户本轮输入加入历史记录。
    context.push({
        role: "user",
        content: userInput,
    });

    // 第一次请求：让模型阅读用户问题，并决定是否需要调用天气工具。
    let response = await client.responses.create({
        model,
        instructions: "你是天气助手。用户询问天气时，使用 get_weather 工具。",
        tools,
        input: context,
    });

    // 先保存模型的完整输出。
    // 如果模型请求调用工具，function_call Item 也必须留在 context 中。
    context.push(...response.output);

    // 第 1 课只处理一次工具调用，所以先用 find 取出第一个 function_call。
    // 这也是本课故意留下的限制：下一课会改成收集全部工具调用并循环处理。
    const toolCall = response.output.find(
        (item) => item.type === "function_call"
    );

    // 如果模型没有调用工具，就直接返回它生成的文字。
    if (!toolCall) {
        return response.output_text;
    }

    // arguments 是 JSON 字符串，需要先解析成 JavaScript 对象。
    const args = JSON.parse(toolCall.arguments);

    // 模型只负责提出调用请求，真正的函数由我们的应用在本地执行。
    let result;
    try {
        result = await callFunction(toolCall.name, args);
    } catch (error) {
        // 工具错误也转换成结果交给模型，让模型决定如何向用户解释。
        result = {
            error: error instanceof Error ? error.message : String(error),
        };
    }

    // call_id 用来告诉模型：这个结果属于刚才的哪一次工具调用。
    context.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
    });

    // 第二次请求：模型看完天气结果后，再组织面向用户的自然语言回答。
    response = await client.responses.create({
        model,
        instructions: "根据天气工具返回的数据，简洁地回答用户。",
        tools,
        input: context,
    });

    // 最终回答也加入历史，这样下一轮对话仍然知道前面发生过什么。
    context.push(...response.output);

    return response.output_text;
}

// 这是最外层的对话循环。
// 一次循环处理一条用户消息，完成后再等待下一条消息。
while (true) {
    const userInput = (await rl.question("你: ")).trim();

    // 提供几种常见的退出方式，避免只能用 Ctrl+C 强制结束程序。
    if (["退出", "exit", "quit"].includes(userInput.toLowerCase())) {
        break;
    }

    // 空输入没有实际内容，直接进入下一轮等待。
    if (!userInput) {
        continue;
    }

    try {
        const answer = await getAssistantReply(userInput);
        console.log(`AI: ${answer}\n`);
    } catch (error) {
        // 网络错误、鉴权错误和模型错误都会在这里显示。
        const message = error instanceof Error ? error.message : String(error);
        console.error(`请求失败：${message}\n`);
    }
}

// 退出循环后关闭 readline，让 Node.js 进程正常结束。
rl.close();
