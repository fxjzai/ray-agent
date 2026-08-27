import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runBash } from "../src/tools/bash.js";
import { editTextFile } from "../src/tools/edit.js";
import { readTextFile } from "../src/tools/read.js";
import { writeTextFile } from "../src/tools/write.js";

let workspace;

beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "ray-agent-tools-"));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

test("read 支持分段、真实行号和下一 offset", async () => {
    await writeFile(path.join(workspace, "demo.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const result = await readTextFile({ path: "demo.txt", offset: 2, limit: 2 }, workspace);
    assert.equal(result.content, "2: beta\n3: gamma");
    assert.equal(result.totalLines, 4);
    assert.equal(result.nextOffset, 4);
    assert.equal(result.truncated, true);
});

test("read 拒绝越界 offset", async () => {
    await writeFile(path.join(workspace, "demo.txt"), "only one line");
    await assert.rejects(
        readTextFile({ path: "demo.txt", offset: 2 }, workspace),
        /超出文件范围/
    );
});

test("read 截断过长内容并提示继续读取位置", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `${index + 1}-${"x".repeat(100)}`);
    await writeFile(path.join(workspace, "long.txt"), lines.join("\n"));
    const result = await readTextFile({ path: "long.txt", limit: 200 }, workspace);
    assert.equal(result.truncated, true);
    assert.ok(result.nextOffset > 1);
    assert.match(result.note, new RegExp(`offset=${result.nextOffset}`));
    assert.ok(result.content.length <= 12_000);
});

test("文件工具拒绝路径逃逸", async () => {
    await assert.rejects(
        readTextFile({ path: "../secret.txt" }, workspace),
        /工作区之外/
    );
    await assert.rejects(
        writeTextFile({ path: "../secret.txt", content: "no" }, workspace),
        /工作区之外/
    );
});

test("文件工具拒绝通过符号链接离开工作区", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "ray-agent-outside-"));
    try {
        await writeFile(path.join(outside, "secret.txt"), "secret");
        await symlink(outside, path.join(workspace, "link"));
        await assert.rejects(
            readTextFile({ path: "link/secret.txt" }, workspace),
            /符号链接/
        );
    } finally {
        await rm(outside, { recursive: true, force: true });
    }
});

test("write 创建父目录并报告 UTF-8 字节数", async () => {
    const result = await writeTextFile({ path: "nested/demo.txt", content: "你好" }, workspace);
    assert.equal(await readFile(path.join(workspace, "nested/demo.txt"), "utf8"), "你好");
    assert.equal(result.bytesWritten, 6);
});

test("edit 只替换唯一匹配项", async () => {
    await writeFile(path.join(workspace, "demo.js"), "const answer = 41;\n");
    await editTextFile({ path: "demo.js", oldText: "41", newText: "42" }, workspace);
    assert.equal(await readFile(path.join(workspace, "demo.js"), "utf8"), "const answer = 42;\n");
});

test("edit 在零匹配时失败", async () => {
    await writeFile(path.join(workspace, "demo.txt"), "alpha");
    await assert.rejects(
        editTextFile({ path: "demo.txt", oldText: "beta", newText: "gamma" }, workspace),
        /没有匹配项/
    );
});

test("edit 在多匹配时失败", async () => {
    await writeFile(path.join(workspace, "demo.txt"), "same same");
    await assert.rejects(
        editTextFile({ path: "demo.txt", oldText: "same", newText: "other" }, workspace),
        /出现多次/
    );
});

test("bash 返回成功命令的输出和退出码", async () => {
    const result = await runBash({ command: "printf success" }, workspace);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "success");
    assert.equal(result.timedOut, false);
});

test("bash 把非零退出作为可观察结果返回", async () => {
    const result = await runBash({ command: "printf failed >&2; exit 7" }, workspace);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "failed");
    assert.match(result.note, /退出码 7/);
});

test("bash 超时后终止命令", async () => {
    const result = await runBash({ command: "sleep 2", timeout: 50 }, workspace);
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, "SIGKILL");
});

test("bash 截断过长输出", async () => {
    const result = await runBash({ command: "yes x | head -n 10000" }, workspace);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stdout.length, 12_000);
});
