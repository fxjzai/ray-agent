import { spawn } from "node:child_process";
import path from "node:path";
import { MAX_TOOL_OUTPUT_CHARS } from "./common.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export const bashTool = {
    type: "function",
    name: "bash",
    description: "在工作区目录中运行 Shell 命令，返回 stdout、stderr、退出码和超时状态。cwd 限制不是安全沙箱",
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "要执行的 Shell 命令" },
            timeout: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, description: "超时时间（毫秒），默认 30000" },
        },
        required: ["command"],
        additionalProperties: false,
    },
};

export async function runBash({ command, timeout = DEFAULT_TIMEOUT_MS }, workspaceRoot) {
    if (typeof command !== "string" || command.trim() === "") {
        throw new Error("command 必须是非空字符串");
    }
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
        throw new Error(`timeout 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数（毫秒）`);
    }

    const cwd = path.resolve(workspaceRoot);

    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            cwd,
            shell: true,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;

        function collect(current, chunk) {
            const remaining = MAX_TOOL_OUTPUT_CHARS - current.length;
            return {
                text: remaining > 0 ? current + chunk.slice(0, remaining) : current,
                truncated: chunk.length > remaining,
            };
        }

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            const collected = collect(stdout, chunk);
            stdout = collected.text;
            stdoutTruncated ||= collected.truncated;
        });
        child.stderr.on("data", (chunk) => {
            const collected = collect(stderr, chunk);
            stderr = collected.text;
            stderrTruncated ||= collected.truncated;
        });

        child.on("error", reject);

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {
                child.kill("SIGKILL");
            }
        }, timeout);

        child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            resolve({
                cwd,
                exitCode,
                signal,
                timedOut,
                stdout,
                stderr,
                stdoutTruncated,
                stderrTruncated,
                note: timedOut
                    ? `命令运行超过 ${timeout}ms，已终止`
                    : exitCode === 0 ? "命令执行成功" : `命令以退出码 ${exitCode} 结束`,
            });
        });
    });
}
