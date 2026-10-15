// 最小出口净化，不是数据分级/审计系统。完整 reasoning 不应进入本模块。
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export function createPublicEvents({ secrets = [], onEvent }) {
    const known = [...new Set(secrets.filter((s) => typeof s === "string" && s.length))].sort((a, b) => b.length - a.length);
    const pending = new Map();
    const clean = (text) => known.reduce((s, secret) => s.replaceAll(secret, "<redacted>"), String(text)).replace(controls, "");
    function sanitize(value) {
        if (typeof value === "string") return clean(value);
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), sanitize(item)]));
        return value;
    }
    return {
        clean,
        emit(event) {
            if (event.type === "text_delta") {
                const key = `${event.messageId}:${event.partIndex}`;
                let text = (pending.get(key) ?? "") + event.delta;
                // 保留可能属于已配置密钥的后缀，防止跨 chunk 把密钥逐段输出。
                text = known.reduce((s, secret) => s.replaceAll(secret, "<redacted>"), text);
                let hold = 0;
                for (const secret of known) {
                    for (let size = 1; size < secret.length && size <= text.length; size++) {
                        if (text.endsWith(secret.slice(0, size))) hold = Math.max(hold, size);
                    }
                }
                pending.set(key, hold ? text.slice(-hold) : "");
                onEvent(sanitize({ ...event, delta: hold ? text.slice(0, -hold) : text }));
                return;
            }
            if (event.type === "message_end") {
                for (const key of pending.keys()) if (key.startsWith(`${event.messageId}:`)) pending.delete(key);
                // 最终快照校准显示；异常收尾也不泄露可能是密钥的尾部前缀。
                let text = event.text;
                if (event.status !== "completed") {
                    let hold = 0;
                    for (const secret of known) for (let size = 1; size < secret.length && size <= text.length; size++) {
                        if (text.endsWith(secret.slice(0, size))) hold = Math.max(hold, size);
                    }
                    if (hold) text = text.slice(0, -hold) + "<redacted>";
                }
                onEvent(sanitize({ ...event, text }));
                return;
            }
            if (event.type === "agent_end") pending.clear();
            onEvent(sanitize(event));
        },
    };
}
