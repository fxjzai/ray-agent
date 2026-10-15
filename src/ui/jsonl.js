export function createJsonlOutput(write) {
    return { onEvent(event) { write(`${JSON.stringify(event)}\n`); } };
}
