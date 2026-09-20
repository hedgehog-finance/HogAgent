import readline from "node:readline";

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  switch (request.method) {
    case "server/discover":
      fail(request.id, -32601, "Method not found");
      break;
    case "initialize":
      send(request.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "test-legacy-mcp", version: "1.0.0" },
      });
      break;
    case "tools/list":
      send(request.id, {
        tools: [
          { name: "echo", description: "Echo authorized text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          { name: "hidden", description: "Must remain invisible", inputSchema: { type: "object", properties: {} } },
          { name: "read_env", description: "Read explicitly mapped test environment", inputSchema: { type: "object", properties: {} } },
        ],
      });
      break;
    case "tools/call": {
      const name = request.params?.name;
      if (name === "echo") {
        send(request.id, { content: [{ type: "text", text: String(request.params?.arguments?.text ?? "") }] });
      } else if (name === "read_env") {
        send(request.id, { content: [{ type: "text", text: process.env.TEST_CHILD_SECRET || "missing" }] });
      } else {
        fail(request.id, -32601, "Unknown tool");
      }
      break;
    }
    case "resources/list":
      send(request.id, { resources: [{ uri: "docs://allowed/readme", name: "Readme", mimeType: "text/plain" }] });
      break;
    case "resources/templates/list":
      send(request.id, { resourceTemplates: [{ uriTemplate: "docs://allowed/{id}", name: "Document" }] });
      break;
    case "resources/read":
      send(request.id, { contents: [{ uri: request.params?.uri, mimeType: "text/plain", text: "resource body" }] });
      break;
    case "prompts/list":
      send(request.id, { prompts: [{ name: "review", description: "Review prompt", arguments: [{ name: "topic", required: true }] }] });
      break;
    case "prompts/get":
      send(request.id, { messages: [{ role: "user", content: { type: "text", text: `Review ${request.params?.arguments?.topic || ""}` } }] });
      break;
    default:
      fail(request.id, -32601, "Method not found");
  }
});
