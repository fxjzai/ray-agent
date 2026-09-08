// 真实 CLI stdin + DeepSeek。父进程注入消息，不是人工终端截图。
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const workspace = await mkdtemp(path.join(os.tmpdir(), "ray-agent-cli05-"));
const lines = [];
const events = [];
const secrets = [process.env.OPENAI_API_KEY, process.env.AMAP_API_KEY].filter(Boolean);
function record(line) {
    let clean = line.replaceAll(workspace, "<workspace>").replaceAll(repo, "<repo>/");
    for (const secret of secrets) clean = clean.replaceAll(secret, "<redacted>");
    lines.push(clean); console.log(clean);
}
let child;
let timeout;
let closed;
try {
    await cp(path.join(repo, "workspace/demo-project"), workspace, { recursive: true });
    const before = await readFile(path.join(workspace, "src/math.js"), "utf8");
    child = spawn(process.execPath, ["src/interactive.js", workspace], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
    closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
    function send(line) { record(`你（脚本经 stdin 输入）: ${line}`); child.stdin.write(line + "\n"); }
    let buffer = "";
    let started = false;
    let injected = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); record(line);
            if (!started && line.startsWith("输入任务开始")) { started = true; send("只用 read 读取 src/math.js，然后简短解释问题，不要修改文件，不调用其他工具。"); }
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            events.push(event);
            if (!injected && event.type === "tool_start" && event.name === "read") {
                injected = true;
                send("/follow 完成后补充一句测试建议，不调用工具。");
                send("/steer 先别修改，用一句话解释加法写成减法的问题，不调用任何工具。");
            }
            if (event.type === "agent_end") send("/exit");
        }
    });
    child.stderr.on("data", (chunk) => record(`stderr: ${String(chunk)}`));
    child.stdin.on("error", (error) => record(`stdin: ${error.code}`));
    timeout = setTimeout(() => { record("watchdog: 请求取消并退出"); send("/cancel"); send("/exit"); }, 45000);
    const code = await closed;
    assert.equal(code, 0);
    assert.equal(injected, true);
    assert.deepEqual(events.filter((event) => event.type === "message").map((event) => event.kind), ["prompt", "steer", "follow_up"]);
    assert.equal(events.findLast((event) => event.type === "agent_end").status, "completed");
    assert.ok(!events.some((event) => event.type === "tool_start" && event.name !== "read"));
    assert.equal(await readFile(path.join(workspace, "src/math.js"), "utf8"), before);
    record("verification: passed; real CLI stdin + DeepSeek; source unchanged; input source=scripted");
} catch (error) {
    record(`verification: failed; ${error.message}`); process.exitCode = 1;
} finally {
    clearTimeout(timeout);
    if (child?.exitCode === null) { child.stdin.end("/cancel\n/exit\n"); await closed; }
    await rm(workspace, { recursive: true, force: true });
    await writeFile(path.join(repo, "docs/lesson-05/trace-cli.txt"), lines.join("\n") + "\n");
}
