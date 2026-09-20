import { createHmac } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWebJwtService,
  loadWebJwtService,
  WEB_JWT_AUDIENCE,
  WEB_JWT_ISSUER,
  WEB_JWT_SECRET_FILENAME,
  WEB_JWT_TTL_SECONDS,
} from "../../src/web/auth.ts";

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

function signClaims(secret: Buffer, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${signature}`;
}

describe("WebUI JWT", () => {
  it("issues unique HS256 tokens with a fixed seven-day lifetime", () => {
    const now = Date.UTC(2026, 7, 21, 0, 0, 0);
    const service = createWebJwtService(Buffer.alloc(32, 7), () => now);
    const first = service.issue();
    const second = service.issue();
    const claims = decodeClaims(first);

    expect(first).not.toBe(second);
    expect(claims.iss).toBe(WEB_JWT_ISSUER);
    expect(claims.aud).toBe(WEB_JWT_AUDIENCE);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(WEB_JWT_TTL_SECONDS);
    expect(service.verify(first)?.jti).toBe(claims.jti);
  });

  it("rejects expired, tampered, wrong-issuer, and wrong-audience tokens", () => {
    let now = Date.UTC(2026, 7, 21, 0, 0, 0);
    const secret = Buffer.alloc(32, 9);
    const service = createWebJwtService(secret, () => now);
    const token = service.issue();
    const claims = decodeClaims(token);

    expect(service.verify(`${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`)).toBeNull();
    expect(service.verify(signClaims(secret, { ...claims, iss: "other" }))).toBeNull();
    expect(service.verify(signClaims(secret, { ...claims, aud: "other" }))).toBeNull();

    now += WEB_JWT_TTL_SECONDS * 1000;
    expect(service.verify(token)).toBeNull();
  });

  it("persists one owner-only 256-bit secret", () => {
    const systemDir = mkdtempSync(join(tmpdir(), "hogagent-web-auth-"));
    try {
      const first = loadWebJwtService(systemDir);
      const firstToken = first.issue();
      const secretPath = join(systemDir, WEB_JWT_SECRET_FILENAME);
      const secret = readFileSync(secretPath);

      const second = loadWebJwtService(systemDir);
      expect(secret).toHaveLength(32);
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
      expect(second.verify(firstToken)).not.toBeNull();
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  });

  it("rejects symbolic and hard-linked secret files without following them", () => {
    const root = mkdtempSync(join(tmpdir(), "hogagent-web-auth-link-"));
    const target = join(root, "target.key");
    writeFileSync(target, Buffer.alloc(32, 3), { mode: 0o644 });
    try {
      const symlinkDir = join(root, "symlink");
      const hardlinkDir = join(root, "hardlink");
      mkdirSync(symlinkDir);
      symlinkSync(target, join(symlinkDir, WEB_JWT_SECRET_FILENAME));
      expect(() => loadWebJwtService(symlinkDir)).toThrow(/unlinked regular file/);
      expect(statSync(target).mode & 0o777).toBe(0o644);

      // Use a real directory for the hard-link case; the secret itself aliases
      // an external inode and must not be accepted as the signing key.
      mkdirSync(hardlinkDir);
      linkSync(target, join(hardlinkDir, WEB_JWT_SECRET_FILENAME));
      expect(() => loadWebJwtService(hardlinkDir)).toThrow(/unlinked regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
