import Ajv from "ajv";

// 定义、实现和执行策略放在一起，模型可见的定义由同一份注册信息导出。
export class ToolRegistry {
    #tools = new Map();
    #ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });

    register({ definition, execute, executionMode = "sequential", requiresApproval = true }) {
        if (definition?.type !== "function" || typeof definition.name !== "string" || !definition.name) {
            throw new Error("工具必须提供 function 定义和非空名称");
        }
        if (this.#tools.has(definition.name)) {
            throw new Error(`工具重复注册：${definition.name}`);
        }
        if (typeof execute !== "function") {
            throw new Error(`工具缺少执行函数：${definition.name}`);
        }
        if (!["parallel", "sequential"].includes(executionMode) || typeof requiresApproval !== "boolean") {
            throw new Error(`工具执行策略无效：${definition.name}`);
        }
        if (!definition.parameters || typeof definition.parameters !== "object") {
            throw new Error(`工具缺少参数 Schema：${definition.name}`);
        }

        // 在注册时编译 Schema。定义错误尽早暴露，不等到模型调用时才发现。
        const validate = this.#ajv.compile(definition.parameters);
        this.#tools.set(definition.name, { definition, execute, executionMode, requiresApproval, validate });
        return this;
    }

    get(name) {
        return this.#tools.get(name);
    }

    definitions() {
        return [...this.#tools.values()].map((tool) => tool.definition);
    }
}
