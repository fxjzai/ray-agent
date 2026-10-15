import { messageText, parseResponsesOutput } from "./responses-output.js";

// Provider 流 → 最小消息事件。只暴露回答文本，不转发 reasoning/参数碎片。
export async function consumeResponsesStream(stream, { input, signal, onEvent = () => {} }) {
    const messages = new Map();
    let completed = false;
    function emit(event) {
        try { Promise.resolve(onEvent(structuredClone(event))).catch(() => {}); } catch { /* 观察者不是执行屏障 */ }
    }
    function getMessage(index) {
        if (!Number.isInteger(index) || index < 0) throw new Error("流事件缺少有效 output_index");
        if (!messages.has(index)) {
            const entry = { messageId: String(index), parts: new Map(), ended: false };
            messages.set(index, entry);
            emit({ type: "message_start", messageId: entry.messageId, role: "assistant" });
        }
        return messages.get(index);
    }
    const partialText = (entry) => [...entry.parts].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
    function end(entry, status, text = partialText(entry)) {
        if (entry.ended) return;
        entry.ended = true;
        emit({ type: "message_end", messageId: entry.messageId, status, text });
    }
    try {
        signal?.throwIfAborted();
        for await (const event of stream) {
            signal?.throwIfAborted();
            if (event.type === "response.output_item.added" && event.item?.type === "message") {
                getMessage(event.output_index);
            } else if (event.type === "response.output_text.delta") {
                if (typeof event.delta !== "string" || !Number.isInteger(event.content_index) || event.content_index < 0) {
                    throw new Error("文本增量缺少有效内容或 content_index");
                }
                const entry = getMessage(event.output_index);
                entry.parts.set(event.content_index, (entry.parts.get(event.content_index) ?? "") + event.delta);
                emit({ type: "text_delta", messageId: entry.messageId, partIndex: event.content_index, delta: event.delta });
            } else if (event.type === "response.completed") {
                // final response 是权威结果；不依赖不完整 JSON 拼接，也不二次追加全文。
                const result = parseResponsesOutput(event.response, input);
                signal?.throwIfAborted();
                for (const [index] of messages) {
                    if (result.output[index]?.type !== "message") throw new Error("流式消息与最终 output 不匹配");
                }
                for (const [index, item] of result.output.entries()) {
                    if (item.type === "message") end(getMessage(index), "completed", messageText(item));
                }
                signal?.throwIfAborted();
                completed = true;
                return result;
            } else if (["response.incomplete", "response.failed", "error"].includes(event.type)) {
                const error = new Error(`模型流未完成：${event.type}`);
                error.status = event.type === "response.incomplete" ? "incomplete" : "error";
                throw error;
            }
        }
        // SDK 取消可能以正常迭代结束呈现，不能误报为网络截断。
        signal?.throwIfAborted();
        throw new Error("模型流提前结束，缺少完成事件");
    } catch (error) {
        for (const entry of messages.values()) end(entry, signal?.aborted ? "cancelled" : error.status ?? "error");
        throw error;
    } finally {
        // 真实 SDK 流在取消/异常时关闭 HTTP；普通 async iterable 由 for-await 负责 return。
        if (!completed) stream.controller?.abort();
    }
}
