/**
 * Web Fetch Tool
 *
 * Fetches a web page and extracts its main content as Markdown.
 * Uses @mozilla/readability for article extraction, jsdom for DOM parsing,
 * and turndown for HTML→Markdown conversion.
 */

import { Type, type Static } from "@sinclair/typebox";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { truncateByTokens, estimateStringTokens } from "../utils/token-estimation.ts";
import type { AgentTool, AgentToolResult } from "../vendor/agent/types.ts";
import { recordArtifactOrigin, recordArtifactWrite } from "../artifacts/artifact-protocol.ts";
import type { HogAgentConfig } from "../utils/types.ts";

// ─── Schema ──────────────────────────────────────────────────────────────────

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL of the web page to fetch" }),
  max_length: Type.Optional(Type.Number({ description: "Maximum output length in tokens (default: 8000)" })),
});

type WebFetchInput = Static<typeof WebFetchParams>;

// ─── Fetch & Extract ─────────────────────────────────────────────────────────

/** Default fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 30_000;

async function fetchAndExtract(url: string): Promise<{ title: string; content: string; excerpt: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "HogAgent/3.0 (compatible; research bot)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      const text = await response.text();
      return { title: url, content: text.slice(0, 10000), excerpt: text.slice(0, 200) };
    }

    const html = await response.text();

    // Dynamic imports for Node.js modules
    const { JSDOM } = await import("jsdom");
    const { Readability } = await import("@mozilla/readability");
    const TurndownService = (await import("turndown")).default;

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.content) {
      // Fallback: convert entire body
      const body = dom.window.document.body?.innerHTML || html;
      const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      const md = turndown.turndown(body);
      return { title: url, content: md, excerpt: md.slice(0, 200) };
    }

    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const markdown = turndown.turndown(article.content);

    return {
      title: article.title || url,
      content: markdown,
      excerpt: article.excerpt || markdown.slice(0, 200),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Tool Factory ────────────────────────────────────────────────────────────

export function createWebFetchTool(getTaskDir?: () => string, getArtifactConfig?: () => HogAgentConfig): AgentTool {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and extract its main content as Markdown.",
    parameters: WebFetchParams,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const params = rawParams as WebFetchInput;
      const { url, max_length: rawMaxLength } = params;
      const maxLength = Math.min(Math.max(rawMaxLength ?? 8000, 500), 40000);

      try {
        const article = await fetchAndExtract(url);

        const rawOutput = `# ${article.title}\n\n${article.content}`;

        // Save full content to file when large (> 1600 tokens) and task dir available
        const artifactConfig = getArtifactConfig?.();
        const taskDir = artifactConfig?.projectDir ? join(artifactConfig.projectDir, "data") : getTaskDir?.();
        if (taskDir && estimateStringTokens(rawOutput) > 1600) {
          try {
            if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
            const ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
            // Filename: data-<datetime>-<N>.md (N prevents collision)
            let n = 1;
            let filepath: string;
            for (;;) {
              filepath = join(taskDir, `data-${ts}-${n++}.md`);
              try { writeFileSync(filepath, rawOutput, { encoding: "utf-8", flag: "wx" }); break; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            }
            if (artifactConfig) recordArtifactWrite(artifactConfig, filepath);
            let originWarning: string | undefined;
            try { recordArtifactOrigin(artifactConfig?.projectDir ?? taskDir, filepath, {
              type: "web_fetch",
              tool: "web_fetch",
              fetched_at: new Date().toISOString(),
              locator: url,
              title: article.title,
              content_type: "text/markdown",
            }); } catch (error) { originWarning = `File saved, but origin registration failed: ${String(error)}. Do not re-fetch.`; }

            // Return summary + pointer
            const { text: preview } = truncateByTokens(rawOutput, 800, "...");
            const summaryText = `[WebFetch Saved] ${filepath}\nURL: ${url}\nTitle: ${article.title}\nSize: ${rawOutput.length} chars\n\nPreview:\n${preview}\n\nHint: read(path=${JSON.stringify(filepath)}, offset=1, limit=2000); follow each returned next offset to read further pages. Each read is bounded, including raw reads.`;
            return {
              content: [{ type: "text", text: summaryText + (originWarning ? `\n${originWarning}` : "") }],
              details: { url, title: article.title, length: rawOutput.length, saved_to: filepath, ...(originWarning ? { origin_warning: originWarning } : {}) },
            };
          } catch { /* fall through to normal output */ }
        }

        const { text: output, truncated } = truncateByTokens(rawOutput, maxLength);

        return {
          content: [{ type: "text", text: output }],
          details: {
            url,
            title: article.title,
            length: output.length,
            truncated,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Fetch error: ${message}` }],
          details: { error: message, url },
        };
      }
    },
  };
}
