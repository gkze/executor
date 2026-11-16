/**
 * A stdio MCP server for the local stdio bridge scenario, as the source of a Node program the
 * scenario writes to a file and the local server runs. It speaks newline-delimited JSON-RPC itself,
 * so it needs no package. `report` answers which process served it, how many calls that process has
 * served, and what of its environment the bridge set; `exit` ends the process without answering,
 * as a crash would; `ask` asks its caller a question over stdio and answers with the reply.
 */
export const stdioMcpUpstreamSource = `
import { createInterface } from "node:readline";

let calls = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const tools = [
  {
    name: "report",
    description: "Report this process and its environment",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  { name: "exit", description: "End this process without answering", inputSchema: { type: "object", properties: {} } },
  { name: "ask", description: "Ask the caller for a colour", inputSchema: { type: "object", properties: {} } },
];
/** Calls waiting for the answer to the question they asked, by the question's ID. */
const asking = new Map();

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  // An answer to a question this server asked.
  if (message.method === undefined) {
    const call = asking.get(message.id);
    asking.delete(message.id);
    if (call !== undefined) send({ id: call, result: text({ answer: message.result ?? message.error }) });
    return;
  }
  // Notifications, such as notifications/initialized, need no answer.
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-fixture", version: "1.0.0" },
        },
      });
    case "ping":
      return send({ id: message.id, result: {} });
    case "tools/list":
      return send({ id: message.id, result: { tools } });
    case "tools/call":
      if (message.params.name === "exit") process.exit(1);
      if (message.params.name === "ask") {
        const question = "ask-" + message.id;
        asking.set(question, message.id);
        return send({
          id: question,
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Pick a colour",
            requestedSchema: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] },
          },
        });
      }
      return send({
        id: message.id,
        result: text({
          pid: process.pid,
          calls: ++calls,
          plain: process.env.FIXTURE_PLAIN ?? null,
          secret: process.env.FIXTURE_SECRET ?? null,
          // The bridge passes no variable of the server's own, such as its keys.
          executorKeys: Object.keys(process.env).filter((key) => key.startsWith("EXECUTOR_")),
        }),
      });
    default:
      return send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
