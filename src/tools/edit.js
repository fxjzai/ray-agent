import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./common.js";

export const editTool = {
    type: "function",
    name: "edit",
    description: "在工作区文件中精确替换唯一出现的一段文本；oldText 必须只匹配一次",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "相对工作区的文件路径" },
            oldText: { type: "string", description: "文件中只出现一次的原文本" },
            newText: { type: "string", description: "替换后的新文本" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
    },
};

export async function editTextFile({ path: requestedPath, oldText, newText }, workspaceRoot) {
    if (typeof oldText !== "string" || oldText.length === 0) {
        throw new Error("oldText 必须是非空字符串");
    }
    if (typeof newText !== "string") {
        throw new Error("newText 必须是字符串");
    }

    const filePath = resolveWorkspacePath(workspaceRoot, requestedPath);
    let content;
    try {
        content = await readFile(filePath, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`文件不存在：${requestedPath}`);
        }
        throw error;
    }

    const firstMatch = content.indexOf(oldText);
    if (firstMatch === -1) {
        throw new Error("oldText 在文件中没有匹配项，请先 read 获取准确内容");
    }
    if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
        throw new Error("oldText 在文件中出现多次，请提供更完整且唯一的上下文");
    }

    const updated = content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
    await writeFile(filePath, updated, "utf8");

    return {
        path: path.relative(realpathSync(path.resolve(workspaceRoot)), filePath),
        bytesWritten: Buffer.byteLength(updated, "utf8"),
        message: "已替换唯一匹配项",
    };
}
