import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./common.js";

export const writeTool = {
    type: "function",
    name: "write",
    description: "创建或完整覆盖工作区内的 UTF-8 文本文件，并自动创建父目录",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "相对工作区的文件路径" },
            content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
        additionalProperties: false,
    },
};

export async function writeTextFile({ path: requestedPath, content }, workspaceRoot) {
    if (typeof content !== "string") {
        throw new Error("content 必须是字符串");
    }

    const filePath = resolveWorkspacePath(workspaceRoot, requestedPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");

    return {
        path: path.relative(realpathSync(path.resolve(workspaceRoot)), filePath),
        bytesWritten: Buffer.byteLength(content, "utf8"),
        message: "文件写入完成",
    };
}
