import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("WebUI streaming order", () => {
  it("defers the assistant bubble until text arrives so thinking stays before the answer", () => {
    const source = readFileSync(resolve("src/web/public/app.js"), "utf8");
    const messageStart = source.slice(
      source.indexOf('case "message_start"'),
      source.indexOf('case "thinking_start"'),
    );
    const messageUpdate = source.slice(
      source.indexOf('case "message_update"'),
      source.indexOf('case "message_end"'),
    );

    expect(messageStart).not.toContain("addMessage(");
    expect(messageStart).toContain("state.streamingMessageId = null");
    expect(messageUpdate).toContain("if (!state.streamingMessageId) state.streamingMessageId = addMessage(");
  });

  it("exits Long Task internal mode before streaming the final assistant answer", () => {
    const appSource = readFileSync(resolve("src/web/public/app.js"), "utf8");
    const orchestratorSource = readFileSync(resolve("src/long-task-orchestrator.ts"), "utf8");
    const messageUpdate = appSource.slice(
      appSource.indexOf('case "message_update"'),
      appSource.indexOf('case "message_end"'),
    );
    const finalPromptFlow = orchestratorSource.slice(
      orchestratorSource.indexOf("// Exit internal mode so the main LLM's reply renders as a chat bubble"),
      orchestratorSource.indexOf("setSuppressUserBubble(false);"),
    );

    expect(messageUpdate).toContain("if (state.internalMode)");
    expect(messageUpdate).toContain("appendThinkingSection(delta, t('chat.executionProcess'))");
    expect(finalPromptFlow.indexOf("setInternalMode(false)")).toBeLessThan(
      finalPromptFlow.indexOf("deps.mainHarness.prompt(finalPrompt)"),
    );
  });
});
