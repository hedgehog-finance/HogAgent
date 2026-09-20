import readline from "node:readline";

const taskState = new Map();

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
      send(request.id, {
        supportedVersions: ["2026-07-28"],
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "test-modern-mcp",
            version: "1.0.0",
          },
        },
      });
      break;
    case "tools/list":
      send(request.id, {
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        tools: [
          { name: "interactive", inputSchema: { type: "object", properties: {} } },
          { name: "long_task", inputSchema: { type: "object", properties: {} } },
          { name: "disconnect", inputSchema: { type: "object", properties: {} } },
        ],
      });
      break;
    case "tools/call": {
      const name = request.params?.name;
      if (name === "disconnect") {
        process.exit(0);
      }
      if (name === "interactive") {
        const response = request.params?.inputResponses?.confirmation;
        if (!response) {
          send(request.id, {
            resultType: "input_required",
            requestState: "interactive-state",
            inputRequests: {
              confirmation: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "Continue?",
                  requestedSchema: {
                    type: "object",
                    properties: { approved: { type: "boolean" } },
                    required: ["approved"],
                  },
                },
              },
            },
          });
        } else {
          send(request.id, {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            content: [{ type: "text", text: `approved=${response.content?.approved === true}` }],
          });
        }
      } else if (name === "long_task") {
        taskState.set("task-1", { responded: false, cancelOnPoll: request.params?.arguments?.cancelOnPoll === true });
        send(request.id, { resultType: "task", taskId: "task-1", pollIntervalMs: 1 });
      } else {
        fail(request.id, -32601, "Unknown tool");
      }
      break;
    }
    case "tasks/get": {
      const state = taskState.get(request.params?.taskId);
      if (!state) {
        fail(request.id, -32602, "Unknown task");
      } else if (state.cancelOnPoll) {
        send(request.id, { resultType: "complete", status: "cancelled" });
      } else if (!state.responded) {
        send(request.id, {
          resultType: "complete",
          status: "input_required",
          inputRequests: {
            checkpoint: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Approve task?",
                requestedSchema: {
                  type: "object",
                  properties: { approved: { type: "boolean" } },
                  required: ["approved"],
                },
              },
            },
          },
        });
      } else {
        send(request.id, {
          resultType: "complete",
          status: "completed",
          result: { content: [{ type: "text", text: "task complete" }] },
        });
      }
      break;
    }
    case "tasks/update": {
      const state = taskState.get(request.params?.taskId);
      if (!state) fail(request.id, -32602, "Unknown task");
      else {
        state.responded = true;
        send(request.id, { resultType: "complete", status: "working" });
      }
      break;
    }
    case "tasks/cancel":
      taskState.delete(request.params?.taskId);
      send(request.id, { resultType: "complete", status: "cancelled" });
      break;
    case "resources/list":
      send(request.id, { resultType: "complete", ttlMs: 0, cacheScope: "private", resources: [] });
      break;
    case "resources/templates/list":
      send(request.id, { resultType: "complete", ttlMs: 0, cacheScope: "private", resourceTemplates: [] });
      break;
    case "prompts/list":
      send(request.id, { resultType: "complete", ttlMs: 0, cacheScope: "private", prompts: [] });
      break;
    default:
      fail(request.id, -32601, "Method not found");
  }
});
