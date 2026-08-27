import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_TOOL_OUTPUT_CHARS, resolveWorkspacePath } from "./common.js";

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1_000;

export const readTool = {
    type: "function",
    name: "read",
    description: "按行读取工作区内的 UTF-8 文本文件；长文件可用 offset 和 limit 分段读取",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "相对工作区的文件路径" },
            offset: { type: "integer", minimum: 1, description: "从第几行开始，行号从 1 开始" },
            limit: { type: "integer", minimum: 1, maximum: MAX_LINE_LIMIT, description: "最多读取多少行" },
        },
        required: ["path"],
        additionalProperties: false,
    },
};

export async function readTextFile({ path: requestedPath, offset = 1, limit = DEFAULT_LINE_LIMIT }, workspaceRoot) {
    if (!Number.isInteger(offset) || offset < 1) {
        throw new Error("offset 必须是大于等于 1 的整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LINE_LIMIT) {
        throw new Error(`limit 必须是 1 到 ${MAX_LINE_LIMIT} 之间的整数`);
    }

    const filePath = resolveWorkspacePath(workspaceRoot, requestedPath);
    let fileStat;
    try {
        fileStat = await stat(filePath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`文件不存在：${requestedPath}`);
        }
        throw error;
    }
    if (!fileStat.isFile()) {
        throw new Error(`不是普通文件：${requestedPath}`);
    }

    const content = await readFile(filePath, "utf8");
    const lines = content === "" ? [] : content.split(/\r?\n/);
    if (lines.at(-1) === "") {
        lines.pop();
    }
    const totalLines = lines.length;

    if (offset > Math.max(totalLines, 1)) {
        throw new Error(`offset ${offset} 超出文件范围（共 ${totalLines} 行）`);
    }

    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const rendered = [];
    let charCount = 0;
    let clippedByChars = false;

    for (let index = 0; index < selected.length; index++) {
        const renderedLine = `${offset + index}: ${selected[index]}`;
        const extraChars = renderedLine.length + (rendered.length > 0 ? 1 : 0);
        if (rendered.length > 0 && charCount + extraChars > MAX_TOOL_OUTPUT_CHARS) {
            clippedByChars = true;
            break;
        }
        rendered.push(renderedLine.slice(0, MAX_TOOL_OUTPUT_CHARS));
        charCount += Math.min(extraChars, MAX_TOOL_OUTPUT_CHARS);
        if (renderedLine.length > MAX_TOOL_OUTPUT_CHARS) {
            clippedByChars = true;
            break;
        }
    }

    const readCount = rendered.length;
    const nextOffset = offset - 1 + readCount < totalLines ? offset + readCount : null;

    return {
        path: path.relative(path.resolve(workspaceRoot), filePath) || ".",
        offset,
        lineCount: readCount,
        totalLines,
        content: rendered.join("\n"),
        truncated: clippedByChars || nextOffset !== null,
        nextOffset,
        note: nextOffset === null ? "已读到文件末尾" : `还有内容，可从 offset=${nextOffset} 继续读取`,
    };
}
