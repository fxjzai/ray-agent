import { bashTool, runBash } from "../tools/bash.js";
import { editTextFile, editTool } from "../tools/edit.js";
import { readTextFile, readTool } from "../tools/read.js";
import { writeTextFile, writeTool } from "../tools/write.js";
import { ToolRegistry } from "./tool-registry.js";

// 只有开发者明确标记的只读工具才能并行；元数据不接受模型覆盖。
export function createCodingToolRegistry() {
    return new ToolRegistry()
        .register({ definition: readTool, execute: readTextFile,
            executionMode: "parallel", requiresApproval: false })
        .register({ definition: writeTool, execute: writeTextFile })
        .register({ definition: editTool, execute: editTextFile })
        .register({ definition: bashTool, execute: runBash });
}
