import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";

export const MAX_TOOL_OUTPUT_CHARS = 12_000;

export function resolveWorkspacePath(workspaceRoot, requestedPath) {
    if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
        throw new Error("path 必须是非空字符串");
    }

    const root = realpathSync(path.resolve(workspaceRoot));
    const target = path.resolve(root, requestedPath);
    const relative = path.relative(root, target);

    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`拒绝访问工作区之外的路径：${requestedPath}`);
    }

    // 教程版不跟随工作区内的符号链接，避免它们把文件工具带到工作区之外。
    // 这仍不能替代生产环境中的沙箱，也不解决检查后路径被替换的竞态条件。
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(`拒绝访问符号链接路径：${requestedPath}`);
            }
        } catch (error) {
            if (error?.code === "ENOENT") {
                break;
            }
            throw error;
        }
    }

    return target;
}

export function truncateOutput(value, maxChars = MAX_TOOL_OUTPUT_CHARS) {
    const text = String(value ?? "");

    if (text.length <= maxChars) {
        return { text, truncated: false };
    }

    return {
        text: text.slice(0, maxChars),
        truncated: true,
    };
}
