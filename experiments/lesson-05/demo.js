import assert from "node:assert/strict";
import { createSession } from "./session.js";

console.log("模拟调度演示：不请求模型，不执行真实文件或 Shell 操作。");
let turn = 0;
let session;
session = createSession({
    onEvent: (event) => console.log(JSON.stringify(event)),
    runTurn: async ({ messages }) => {
        turn++;
        if (turn === 1) return { text: "计划先读取，再修改", toolCalls: [
            { id: "read-1", name: "read", args: {} },
            { id: "edit-1", name: "edit", args: {} },
        ] };
        return { text: messages.at(-1).kind === "steer" ? "按新要求只解释，不修改" : "补充测试说明" };
    },
    executeTool: async () => {
        // 确定性注入，模拟用户在第一个工具运行期间输入。
        session.followUp("完成后补测试说明");
        session.steer("先别修改，只解释原因");
        return { content: "模拟读取完成" };
    },
});
const result = await session.prompt("检查这个项目");
assert.equal(result.status, "completed");
assert.equal(result.turns, 3);
assert.equal(result.messages.find((m) => m.toolCallId === "edit-1").result.error.code, "STEERING_SKIPPED");
console.log(JSON.stringify({ verification: "passed", turns: result.turns, editExecuted: false }));
