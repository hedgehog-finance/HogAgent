/**
 * Abstract LLM file parser.
 *
 * Implements the sync file-parsing protocol: POST multipart/form-data,
 * fields: file(binary) / tool_type / file_type.
 * Response: { status, message, content, task_id, parsing_result_url }.
 * Returns `content` as Markdown when status==="succeeded".
 *
 * Endpoint URL and credentials come from config; this module is vendor-agnostic —
 * switch providers by configuring a different endpoint.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { log } from "./doc-utils.mjs";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

async function readResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`File parser response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error(`File parser response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    return buffer.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`File parser response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Convert a document to Markdown via file-parsing service.
 * @param {string} filePath Absolute path to input file
 * @param {string} fileType File type enum (PDF / DOCX / HTML / MD, etc.)
 * @param {{ apiKey: string, endpoint: string, toolType?: string }} config
 * @returns {Promise<string>} Markdown text
 */
export async function parseFileWithLlm(filePath, fileType, config) {
  const { apiKey, endpoint, toolType = "prime-sync" } = config;
  if (!apiKey || !endpoint) {
    throw new Error("LLM parsing path not configured: both endpoint and apiKey required");
  }
  if (typeof apiKey !== "string" || /[\r\n]/.test(apiKey) || apiKey.length > 8192) {
    throw new Error("File parser API key must be a single-line string no longer than 8192 characters");
  }
  if (typeof fileType !== "string" || !fileType.trim() || /[\r\n]/.test(fileType) || fileType.length > 100) {
    throw new Error("fileType must be a non-empty single-line string no longer than 100 characters");
  }
  if (typeof toolType !== "string" || !toolType.trim() || /[\r\n]/.test(toolType) || toolType.length > 100) {
    throw new Error("toolType must be a non-empty single-line string no longer than 100 characters");
  }

  const fileStat = statSync(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_INPUT_BYTES) {
    throw new Error(`Input file exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  log("info", `Calling file parser: ${fileName} (file_type=${fileType}, ${fileBuffer.length} bytes)`);

  const body = buildMultipartBody({
    file: { buffer: fileBuffer, filename: fileName },
    tool_type: toolType,
    file_type: fileType,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response;
  let responseText;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${body.boundary}`,
      },
      body: body.buffer,
      signal: controller.signal,
    });
    responseText = await readResponseText(response);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `File parser returned HTTP ${response.status}: ${responseText.slice(0, 500)}`
    );
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = null;
  }
  if (!result) {
    throw new Error("File parser returned non-JSON response");
  }

  if (result.status === "failed") {
    throw new Error(`File parsing failed: ${result.message || "unknown error"}`);
  }

  const content = result.content;
  if (!content || typeof content !== "string") {
    throw new Error(
      `Parser returned no text content (status=${result.status}, message=${result.message || "none"})`
    );
  }

  log("info", `Parsing complete: ${content.length} chars`);
  return content;
}

/**
 * Build multipart/form-data request body.
 * @param {Record<string, string | { buffer: Buffer, filename: string }>} fields
 */
function buildMultipartBody(fields) {
  const boundary = `----doc-convert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      );
    } else {
      const safeFilename = value.filename.replace(/["\r\n]/g, "_");
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        )
      );
      parts.push(value.buffer);
      parts.push(Buffer.from("\r\n"));
    }
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, buffer: Buffer.concat(parts) };
}
