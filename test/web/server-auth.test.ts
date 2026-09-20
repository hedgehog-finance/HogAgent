import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createWebJwtService, WEB_JWT_SECRET_FILENAME } from "../../src/web/auth.ts";
import { startWebServer } from "../../src/web/server.ts";
import { getVersion } from "../../src/version.ts";

function tokenFromHtml(html: string): string {
  const token = html.match(/<meta name="hogagent-web-token" content="([^"]+)">/)?.[1];
  if (!token) throw new Error("WebUI token meta tag missing");
  return token;
}

function rejectedWebSocketStatus(url: string, origin: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolvePromise(status);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("WebSocket unexpectedly authenticated"));
    });
    ws.once("error", () => { /* unexpected-response also emits error on some ws versions */ });
  });
}

describe("WebUI server authentication", () => {
  it("issues fresh page tokens and protects every API and WebSocket before session creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "hogagent-web-server-"));
    const systemDir = join(root, "system");
    const workspace = join(root, "workspace");
    const mockAgent = join(root, "mock-agent.mjs");
    writeFileSync(mockAgent, "process.stdin.resume();\n", "utf8");
    const previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = systemDir;

    const server = await startWebServer({ port: 0, defaultWorkspace: workspace, hogagentPath: mockAgent });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const firstPage = await fetch(`${base}/`);
      const firstHtml = await firstPage.text();
      const firstToken = tokenFromHtml(firstHtml);
      expect(firstHtml).toContain(`<span class="app-version">v${getVersion()}</span>`);
      expect(firstHtml).toContain(`<span class="app-version">HogAgent v${getVersion()}</span>`);
      expect(firstHtml).not.toContain("__HOGAGENT_VERSION__");
      const secondPage = await fetch(`${base}/`);
      const secondToken = tokenFromHtml(await secondPage.text());
      expect(firstToken).not.toBe(secondToken);
      expect(firstPage.headers.get("cache-control")).toBe("no-store");
      expect(firstPage.headers.get("referrer-policy")).toBe("no-referrer");

      expect((await fetch(`${base}/api/themes`)).status).toBe(401);
      expect((await fetch(`${base}/api/does-not-exist`)).status).toBe(401);
      const tamperedToken = `${firstToken.slice(0, -1)}${firstToken.endsWith("a") ? "b" : "a"}`;
      expect((await fetch(`${base}/api/themes`, {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      })).status).toBe(401);
      expect((await fetch(`${base}/api/themes`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      })).status).toBe(200);

      const usersResponse = await fetch(`${base}/api/users?user=2082363713595088897`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      expect(usersResponse.status).toBe(200);
      expect(await usersResponse.json()).toMatchObject({
        selectedUser: "default",
        users: [{ id: "default", workspace_dir: workspace }],
      });
      expect((await fetch(`${base}/api/themes`, {
        headers: { Authorization: `Bearer ${firstToken}`, Host: "[" },
      })).status).toBe(200);
      expect((await fetch(`${base}/api/does-not-exist`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      })).status).toBe(404);
      expect((await fetch(`${base}/api/skills/%E0%A4%A/config`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      })).status).toBe(400);
      expect((await fetch(`${base}/api/themes`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      })).status).toBe(200);

      const secret = readFileSync(join(systemDir, WEB_JWT_SECRET_FILENAME));
      const expired = createWebJwtService(secret, () => Date.now() - 8 * 24 * 60 * 60 * 1000).issue();
      expect((await fetch(`${base}/api/themes`, {
        headers: { Authorization: `Bearer ${expired}` },
      })).status).toBe(401);

      const wsBase = `ws://127.0.0.1:${server.port}/`;
      expect(await rejectedWebSocketStatus(`${wsBase}?user=default`, base)).toBe(401);
      expect(await rejectedWebSocketStatus(`${wsBase}?user=default&token=${encodeURIComponent(firstToken)}`, "http://evil.invalid")).toBe(403);
      expect(await rejectedWebSocketStatus(`${wsBase}?user=default&token=${encodeURIComponent(expired)}`, base)).toBe(401);
      expect(server.sessions.size).toBe(0);

      const valid = new WebSocket(`${wsBase}?user=default&token=${encodeURIComponent(firstToken)}`, { origin: base });
      await new Promise<void>((resolvePromise, reject) => {
        valid.once("open", resolvePromise);
        valid.once("error", reject);
      });
      expect(server.sessions.size).toBe(1);
      expect(Array.from(server.sessions.values())[0]?.workspace).toBe(workspace);
      expect(JSON.parse(readFileSync(join(systemDir, "user_settings.json"), "utf8"))).toMatchObject({
        default: { workspace_dir: workspace },
      });
      valid.close();

      const existingSessionIds = new Set(server.sessions.keys());
      const staleUser = new WebSocket(
        `${wsBase}?user=2082363713595088897&token=${encodeURIComponent(firstToken)}`,
        { origin: base },
      );
      await new Promise<void>((resolvePromise, reject) => {
        staleUser.once("message", () => resolvePromise());
        staleUser.once("error", reject);
      });
      const staleSession = Array.from(server.sessions.values())
        .find((session) => !existingSessionIds.has(session.id));
      expect(staleSession?.user).toBe("default");
      expect(staleSession?.workspace).toBe(workspace);
      staleUser.close();
    } finally {
      await server.shutdown();
      if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
      else process.env.HOGAGENT_USER_DIR = previousUserDir;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
