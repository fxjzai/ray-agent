import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

async function check(directory) {
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) count += await check(file);
        else if (entry.name.endsWith(".js")) { execFileSync(process.execPath, ["--check", file], { stdio: "inherit" }); count++; }
    }
    return count;
}
let total = 0;
for (const directory of ["src", "test", "scripts", "experiments"]) total += await check(directory);
console.log(`语法检查通过：${total} 个 JavaScript 文件（不包含故意失败的 workspace fixture）`);
