import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServer } from "../../src/web/server.ts";
import { loadWebJwtService } from "../../src/web/auth.ts";
import { saveSystemConfig } from "../../src/config.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn,
}));

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((_signal: string) => { child.killed = true; return true; }),
  });
  return child;
}

describe("WebUI subprocess lifecycle", () => {
  let root: string;
  let previousUserDir: string | undefined;
  let server: WebServer;
  let ws: WebSocket;
  let children: ReturnType<typeof fakeChild>[];
  let messages: any[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hogagent-web-lifecycle-"));
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = join(root, "system");
    children = [];
    messages = [];
    mocks.spawn.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    server = await startWebServer({ port: 0, defaultWorkspace: join(root, "workspace"), hogagentPath: join(root, "mock.mjs") });
    const token = loadWebJwtService().issue();
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`, { origin: `http://127.0.0.1:${server.port}` });
    ws.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await server?.shutdown();
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function reconnectClient() {
    const session = [...server.sessions.values()][0]!;
    const originalSocket = session.ws;
    const child = children[0]!;
    const token = loadWebJwtService().issue();
    const second = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`, { origin: `http://127.0.0.1:${server.port}` });
    const received: any[] = [];
    second.on("message", data => received.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { second.once("open", resolve); second.once("error", reject); });
    second.send(JSON.stringify({ type: "reconnect", session_id: session.id }));
    await vi.waitFor(() => expect(received.some(message => message.event?._reconnect)).toBe(true));
    return { session, originalSocket, child, second, received };
  }

  it("retains stderr diagnostics and the original process listeners after reconnect", async () => {
    const child = children[0]!;
    const stdoutListener = child.stdout.listeners("data")[0];
    const { second, received } = await reconnectClient();
    child.stderr.write("diagnostic after reconnect\n");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await vi.waitFor(() => expect(received.some(message => message.event?.type === "error"
      && message.event.error?.includes("diagnostic after reconnect"))).toBe(true));
    expect(child.stdout.listeners("data")).toEqual([stdoutListener]);
    second.close();
  });

  it("replays the latest tool inventory on reconnect after settings changed offline", async () => {
    children[0]!.stdout.write(JSON.stringify({type: "ready", capabilities: {builtin_tools: ["read", "get_tool_details", "query_tool_result"]}}) + "\n");
    children[0]!.stdout.write(JSON.stringify({type: "settings_saved", builtin_tools: ["read"]}) + "\n");
    await vi.waitFor(() => expect([...server.sessions.values()][0]!.tools).toEqual(["read"]));
    // Off → on is persisted for next start; the existing process stays off.
    saveSystemConfig({ extensions: [{ name: "content-compressor", enabled: true, config: { textThreshold: 6000 } }] });
    const {second, received} = await reconnectClient();
    expect(received.find(message => message.event?._reconnect).event.capabilities.builtin_tools).toEqual(["read"]);
    expect(received.find(message => message.event?._reconnect).event.capabilities.systemConfig)
      .toMatchObject({ compressorEnabled: true, compressThreshold: 6000 });
    second.close();
  });

  it("keeps the Web connection ID stable while reconnecting the child business Session and busy state", async () => {
    const session = [...server.sessions.values()][0]!;
    const connectionId = session.id;
    children[0]!.stdout.write(JSON.stringify({
      type: "ready", session_id: "business-session", mode: "long_task", capabilities: { builtin_tools: [] },
    }) + "\n");
    children[0]!.stdout.write(JSON.stringify({ type: "orchestration_resuming", session_id: "business-session" }) + "\n");
    children[0]!.stdout.write(JSON.stringify({ type: "agent_end", session_id: "business-session" }) + "\n");
    await vi.waitFor(() => expect(session.busy).toBe(true));

    const { second, received } = await reconnectClient();
    const ready = received.find(message => message.event?._reconnect)?.event;
    expect(ready).toMatchObject({
      type: "ready",
      session_id: "business-session",
      mode: "long_task",
      _web_connection_id: connectionId,
      _web_busy: true,
    });
    expect(server.sessions.has(connectionId)).toBe(true);
    expect(server.sessions.has("business-session")).toBe(false);

    children[0]!.stdout.write(JSON.stringify({ type: "orchestration_completed", session_id: "business-session" }) + "\n");
    children[0]!.stdout.write(JSON.stringify({ type: "agent_end", session_id: "business-session" }) + "\n");
    await vi.waitFor(() => expect(session.busy).toBe(false));
    second.close();
  });

  it("keeps the reconnect mode aligned with the latest accepted WebUI prompt", async () => {
    const session = [...server.sessions.values()][0]!;
    children[0]!.stdout.write(JSON.stringify({
      type: "ready", session_id: "business-session", mode: "standard", capabilities: { builtin_tools: [] },
    }) + "\n");
    await vi.waitFor(() => expect(session.activeMode).toBe("standard"));

    ws.send(JSON.stringify({
      type: "rpc_command",
      command: { type: "prompt", text: "use quick", mode: "quick" },
    }));
    await vi.waitFor(() => expect(session.activeMode).toBe("quick"));

    const { second, received } = await reconnectClient();
    expect(received.find(message => message.event?._reconnect)?.event.mode).toBe("quick");
    second.close();
  });

  it("ignores queued messages from a replaced socket without sending errors to its replacement", async () => {
    const { session, originalSocket, child, second } = await reconnectClient();
    const send = vi.spyOn(session.ws, "send");
    originalSocket.emit("message", Buffer.from("not json"));
    originalSocket.emit("message", Buffer.from(JSON.stringify({ type: "rpc_command", command: { type: "get_state" } })));
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(child.stdin.readableLength).toBe(0);
    second.close();
  });

  it("preserves multibyte text split across stdout chunks", async () => {
    const line = Buffer.from(JSON.stringify({ type: "message_update", delta: "中文🦔" }) + "\n");
    const split = line.indexOf(Buffer.from("中")) + 1;
    children[0]!.stdout.write(line.subarray(0, split));
    children[0]!.stdout.write(line.subarray(split));
    await vi.waitFor(() => expect(messages.find(message => message.event?.type === "message_update")?.event.delta).toBe("中文🦔"));
  });

  it("rejects a null WebSocket envelope and keeps the connection usable", async () => {
    ws.send("null");
    await vi.waitFor(() => expect(messages.some(message => message.type === "error")).toBe(true));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("creates a fresh process instead of reconnecting to a naturally exited child", async () => {
    const oldId = [...server.sessions.keys()][0]!;
    children[0]!.exitCode = 0;
    children[0]!.emit("exit", 0, null);
    expect(children[0]!.killed).toBe(false);
    ws.close();
    await new Promise<void>(resolve => ws.once("close", resolve));
    const token = loadWebJwtService().issue();
    const second = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`, { origin: `http://127.0.0.1:${server.port}` });
    const received: any[] = [];
    second.on("message", data => received.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { second.once("open", resolve); second.once("error", reject); });
    second.send(JSON.stringify({ type: "reconnect", session_id: oldId }));
    await vi.waitFor(() => expect(server.sessions.has(oldId)).toBe(false));
    expect(server.sessions.size).toBe(1);
    expect(received.some(message => message.event?._reconnect)).toBe(false);
    second.send(JSON.stringify({ type: "rpc_command", command: { type: "get_state" } }));
    const currentChild = children.at(-1)!;
    await vi.waitFor(() => expect(currentChild.stdin.readableLength).toBeGreaterThan(0));
    expect(currentChild).not.toBe(children[0]);
    const freshId = [...server.sessions.keys()][0]!;
    currentChild.stdout.write(JSON.stringify({
      type: "ready", session_id: freshId, mode: null, capabilities: { builtin_tools: [] },
    }) + "\n");
    await vi.waitFor(() => expect(received.some(message => (
      message.event?._web_connection_id === freshId
      && message.event?._web_reconnect_fallback === true
    ))).toBe(true));
    second.close();
  });

  it("retires the old registry entry after new_session", async () => {
    const oldId = [...server.sessions.keys()][0]!;
    ws.send(JSON.stringify({ type: "new_session" }));
    await vi.waitFor(() => expect(children[0]!.stdin.readableLength).toBeGreaterThan(0));
    children[0]!.exitCode = 0;
    children[0]!.emit("exit", 0, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(server.sessions.has(oldId)).toBe(false);
    expect(server.sessions.size).toBe(1);
  });

  it("rejects concurrent switches and commands, then routes commands to the new child", async () => {
    const oldChild = children[0]!;
    ws.send(JSON.stringify({ type: "new_session" }));
    ws.send(JSON.stringify({ type: "new_session" }));
    ws.send(JSON.stringify({ type: "rpc_command", command: { type: "prompt", text: "wrong session" } }));
    await vi.waitFor(() => expect(messages.filter(message => message.error?.includes("switching"))).toHaveLength(2));
    expect(oldChild.stdin.read().toString()).toBe('{"type":"shutdown"}\n');
    oldChild.exitCode = 0;
    oldChild.emit("exit", 0, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    ws.send(JSON.stringify({ type: "rpc_command", command: { type: "get_state" } }));
    await vi.waitFor(() => expect(children[1]!.stdin.readableLength).toBeGreaterThan(0));
    expect(children[1]!.stdin.read().toString()).toBe('{"type":"get_state"}\n');
    expect(server.sessions.size).toBe(1);
  });

  it("rejects reconnecting another socket to a retiring session", async () => {
    const oldId = [...server.sessions.keys()][0]!;
    ws.send(JSON.stringify({ type: "new_session" }));
    await vi.waitFor(() => expect(children[0]!.stdin.readableLength).toBeGreaterThan(0));
    const token = loadWebJwtService().issue();
    const second = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`, { origin: `http://127.0.0.1:${server.port}` });
    const received: any[] = [];
    second.on("message", data => received.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { second.once("open", resolve); second.once("error", reject); });
    second.send(JSON.stringify({ type: "reconnect", session_id: oldId }));
    await vi.waitFor(() => expect(received.some(message => message.error?.includes("switching"))).toBe(true));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    children[0]!.exitCode = 0;
    children[0]!.emit("exit", 0, null);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    expect(server.sessions.has(oldId)).toBe(false);
    second.close();
  });

  it("does not spawn an orphan if the browser disconnects during a switch", async () => {
    ws.send(JSON.stringify({ type: "new_session" }));
    await vi.waitFor(() => expect(children[0]!.stdin.readableLength).toBeGreaterThan(0));
    ws.close();
    await new Promise<void>(resolve => ws.once("close", resolve));
    children[0]!.exitCode = 0;
    children[0]!.emit("exit", 0, null);
    await vi.waitFor(() => expect(server.sessions.size).toBe(0));
    expect(children).toHaveLength(1);
  });

  it("force-kills a child that accepted SIGTERM but has not exited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = children[0]!;
    await server.shutdown();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
