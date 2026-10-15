import { TuiMainScreen, ProcessTerminal, Container, Text, Input, matchesKey } from "@earendil-works/pi-tui";
import { createViewState } from "./view-state.js";

export function createTerminalView({ onLine, onInterrupt, terminal = new ProcessTerminal() }) {
    const tui = new TuiMainScreen(terminal);
    const state = createViewState();
    const transcript = new Container();
    const approvals = new Text("", 0, 0);
    const status = new Text("空闲", 0, 0);
    const input = new Input({ prompt: "你: ", placeholder: "任务，或 /steer /follow /approve /cancel /exit" });
    const texts = [];
    tui.addChild(transcript);
    tui.addChild(approvals);
    tui.addChild(status);
    tui.addChild(input);
    tui.setFocus(input);
    input.onSubmit = (value) => { input.setValue(""); onLine(value); refresh(); };
    tui.addInputListener((data) => {
        if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
            onInterrupt(matchesKey(data, "ctrl+d") ? "exit" : "interrupt");
            return { consume: true };
        }
    });
    function refresh() {
        const snapshot = state.snapshot();
        for (const [index, entry] of snapshot.entries.entries()) {
            if (!texts[index]) { texts[index] = new Text("", 0, 1); transcript.addChild(texts[index]); }
            const prefix = entry.kind === "user" ? "你: " : entry.kind === "assistant" ? "AI: " : "· ";
            const mark = entry.kind === "assistant" && !["streaming", "completed"].includes(entry.status) ? `\n[未完成：${entry.status}]` : "";
            texts[index].setText(prefix + entry.text + mark);
        }
        approvals.setText(snapshot.approvals.map((a) => `审批 ${a.approvalId} · ${a.name} · call_id=${a.callId}\n${JSON.stringify(a.args, null, 2)}\n/approve ${a.approvalId} y|n`).join("\n"));
        status.setText(`── ${snapshot.status} · 排队 ${snapshot.queued} ──`);
        tui.requestRender();
    }
    return {
        onEvent(event) { state.update(event); refresh(); },
        notice(text) { state.notice(text); refresh(); },
        start() { refresh(); tui.start(); },
        stop() { tui.stop(); },
        // 无真实终端也能对输入保持、布局和宽度做定向测试。
        tui, input, state,
    };
}
