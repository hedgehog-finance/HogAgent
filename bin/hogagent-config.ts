#!/usr/bin/env node
/** One JSONL request over stdin, one response over stdout. No Session or model invocation. */
import { executeConfigurationRequest } from "../src/configuration-service.ts";

try {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Configuration request too large");
  }
  const data = await executeConfigurationRequest(JSON.parse(input.replace(/^\uFEFF/, "")));
  process.stdout.write(JSON.stringify({ success: true, data }) + "\n");
} catch (error) {
  // Never echo the request or raw parser error, which may contain credentials.
  const message = error instanceof SyntaxError ? "Invalid configuration JSON" : error instanceof Error ? error.message : "Configuration operation failed";
  process.stdout.write(JSON.stringify({ success: false, error: message }) + "\n");
  process.exitCode = 1;
}
