import { describe, expect, it } from "vitest";
import { buildConversationHistory, messageText } from "../../src/handlers/types.ts";
import { BRANCH_SUMMARY_PREFIX, COMPACTION_SUMMARY_PREFIX } from "../../src/vendor/agent/harness/messages.ts";

describe("conversation history artifact controls", () => {
  it("keeps the assistant summary but removes the delivery control envelope", async () => {
    const sessionRef = {
      current: {
        buildContext: async () => ({
          messages: [
            { role: "user", content: [{ type: "text", text: "生成报告" }] },
            {
              role: "assistant",
              content: [{
                type: "text",
                text: '报告已完成\n{"schema_version":"1.0","type":"delivery_decision","mode":"deliverables"}',
              }],
            },
          ],
        }),
      },
    };

    const history = await buildConversationHistory(sessionRef as never);

    expect(history).toHaveLength(2);
    expect(messageText(history[1]!)).toBe("报告已完成");
  });

  it("removes internal prompts and all assistant replies owned by them", async () => {
    const sessionRef = {
      current: {
        buildContext: async () => ({
          messages: [
            { role: "user", content: [{ type: "text", text: "用户原始要求" }] },
            { role: "assistant", content: [{ type: "text", text: "可见答复" }] },
            { role: "user", content: [{ type: "text", text: "## Planning Only\nmake a plan" }] },
            { role: "assistant", content: [{ type: "text", text: "internal tool turn" }] },
            { role: "assistant", content: [{ type: "text", text: "internal plan JSON" }] },
            { role: "user", content: [{ type: "text", text: "Please re-execute group group_1" }] },
            { role: "assistant", content: [{ type: "text", text: "internal retry result" }] },
            { role: "user", content: [{ type: "text", text: "用户后续要求" }] },
            { role: "assistant", content: [{ type: "text", text: "后续可见答复" }] },
          ],
        }),
      },
    };

    const history = await buildConversationHistory(sessionRef as never);
    expect(history.map(messageText)).toEqual(["用户原始要求", "可见答复", "用户后续要求", "后续可见答复"]);
  });

  it("hides the final control prompt but keeps its visible assistant reply", async () => {
    const sessionRef = {
      current: {
        buildContext: async () => ({
          messages: [
            { role: "user", content: [{ type: "text", text: "## Task Execution Complete\nfinish" }] },
            { role: "assistant", content: [{ type: "text", text: "最终交付摘要" }] },
          ],
        }),
      },
    };

    const history = await buildConversationHistory(sessionRef as never);
    expect(history.map(messageText)).toEqual(["最终交付摘要"]);
  });

  it("excludes synthetic summaries without suppressing later visible messages", async () => {
    const sessionRef = {
      current: {
        buildContext: async () => ({
          messages: [
            { role: "user", content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}internal plan\n</summary>` }] },
            { role: "user", content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}abandoned work\n</summary>` }] },
            { role: "user", content: [{ type: "text", text: "当前用户要求" }] },
            { role: "assistant", content: [{ type: "text", text: "当前可见答复" }] },
          ],
        }),
      },
    };

    const history = await buildConversationHistory(sessionRef as never);
    expect(history.map(messageText)).toEqual(["当前用户要求", "当前可见答复"]);
  });
});
