// dotenv/config 会在程序启动时读取根目录的 .env 文件。
// 这样 API Key 不需要直接写进源码，也就不会误提交到 Git。
import "dotenv/config";

// OpenAI 是官方 JavaScript SDK。
// 即使使用兼容 OpenAI 接口的服务，也可以继续使用这个客户端。
import OpenAI from "openai";

// readline/promises 用来在终端中等待用户输入。
// promises 版本可以配合 await 使用，比回调形式更容易阅读。
import readline from "node:readline/promises";

// SDK 会自动读取 OPENAI_API_KEY 和 OPENAI_BASE_URL。
const client = new OpenAI();

// 模型名也放在 .env 中，方便读者切换自己的服务。
// 如果没有配置 MODEL_NAME，就使用教程当前的默认模型。
const model = process.env.MODEL_NAME || "gpt-5.5";

// context 是本次对话的完整历史。
// 它定义在循环外面，所以每次提问后都不会被重新清空。
const context = [];

// 创建终端输入输出接口。
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// 向模型发送一条用户消息，并返回模型最终生成的文字。
async function getAssistantReply(userInput) {
    // 先把用户本轮输入加入历史记录。
    context.push({
        role: "user",
        content: userInput,
    });

    // 每次请求都把完整 context 发送给模型。
    // 模型能记住前面的内容，是因为它再次看到了这些历史，而不是模型自己保存了记忆。
    const response = await client.responses.create({
        model,
        instructions: "你是一个友好的中文助手。",
        input: context,
    });

    // Responses API 的 output 可能不只包含文字，还可能包含其他 Item。
    // 保存完整 output，可以让后面的课程继续加入推理内容和工具调用。
    context.push(...response.output);

    // output_text 是 SDK 提供的便捷字段，适合直接展示给用户。
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
