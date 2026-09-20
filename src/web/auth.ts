import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getSystemDir } from "../config.ts";

export const WEB_JWT_ISSUER = "hogagent-web";
export const WEB_JWT_AUDIENCE = "hogagent-web";
export const WEB_JWT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const WEB_JWT_SECRET_FILENAME = "web-jwt-secret.key";

interface WebJwtHeader {
  alg: "HS256";
  typ: "JWT";
}

export interface WebJwtClaims {
  iss: typeof WEB_JWT_ISSUER;
  aud: typeof WEB_JWT_AUDIENCE;
  iat: number;
  exp: number;
  jti: string;
}

export interface WebJwtService {
  issue(): string;
  verify(token: string): WebJwtClaims | null;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function signInput(secret: Buffer, input: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

function isWebJwtClaims(value: unknown, nowSeconds: number): value is WebJwtClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<WebJwtClaims>;
  return claims.iss === WEB_JWT_ISSUER
    && claims.aud === WEB_JWT_AUDIENCE
    && Number.isInteger(claims.iat)
    && Number.isInteger(claims.exp)
    && typeof claims.jti === "string"
    && claims.jti.length > 0
    && claims.iat! <= nowSeconds + 60
    && claims.exp! - claims.iat! === WEB_JWT_TTL_SECONDS
    && claims.exp! > nowSeconds;
}

/** Create a deterministic service around a supplied secret (also used by tests). */
export function createWebJwtService(
  secretValue: Uint8Array,
  now: () => number = Date.now,
): WebJwtService {
  const secret = Buffer.from(secretValue);
  if (secret.length !== 32) {
    throw new Error("WebUI JWT secret must be exactly 256 bits");
  }

  return {
    issue(): string {
      const nowSeconds = Math.floor(now() / 1000);
      const header: WebJwtHeader = { alg: "HS256", typ: "JWT" };
      const claims: WebJwtClaims = {
        iss: WEB_JWT_ISSUER,
        aud: WEB_JWT_AUDIENCE,
        iat: nowSeconds,
        exp: nowSeconds + WEB_JWT_TTL_SECONDS,
        jti: randomUUID(),
      };
      const input = `${encodeJson(header)}.${encodeJson(claims)}`;
      return `${input}.${signInput(secret, input).toString("base64url")}`;
    },

    verify(token: string): WebJwtClaims | null {
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
      const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

      try {
        const header = decodeJson(encodedHeader) as Partial<WebJwtHeader>;
        if (header.alg !== "HS256" || header.typ !== "JWT") return null;

        const providedSignature = Buffer.from(encodedSignature, "base64url");
        if (providedSignature.toString("base64url") !== encodedSignature) return null;
        const expectedSignature = signInput(secret, `${encodedHeader}.${encodedClaims}`);
        if (providedSignature.length !== expectedSignature.length
          || !timingSafeEqual(providedSignature, expectedSignature)) {
          return null;
        }

        const claims = decodeJson(encodedClaims);
        const nowSeconds = Math.floor(now() / 1000);
        return isWebJwtClaims(claims, nowSeconds) ? claims : null;
      } catch {
        return null;
      }
    },
  };
}

/** Load the persistent WebUI secret, creating it once with owner-only permissions. */
export function loadWebJwtService(systemDir = getSystemDir()): WebJwtService {
  mkdirSync(systemDir, { recursive: true, mode: 0o700 });
  const secretPath = join(systemDir, WEB_JWT_SECRET_FILENAME);
  const temporaryPath = join(systemDir, `.${WEB_JWT_SECRET_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryExists = false;

  try {
    const fd = openSync(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      writeSync(fd, randomBytes(32));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporaryPath, secretPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
  } finally {
    if (temporaryExists) unlinkSync(temporaryPath);
  }

  const secretStat = lstatSync(secretPath);
  if (secretStat.isSymbolicLink() || !secretStat.isFile() || secretStat.nlink !== 1) {
    throw new Error(`Invalid WebUI JWT secret at ${secretPath}; expected an unlinked regular file`);
  }
  chmodSync(secretPath, 0o600);
  const secret = readFileSync(secretPath);
  if (secret.length !== 32) {
    throw new Error(`Invalid WebUI JWT secret at ${secretPath}; expected 32 bytes`);
  }
  return createWebJwtService(secret);
}

export function extractBearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}
