import { describe, expect, it } from "vitest";
import {
  chatThreadModelSelectionContract,
  chatEventsContract,
} from "../chat-threads";
import {
  compatibleReasoningEffort,
  getModelReasoningEfforts,
  isModelReasoningEffortSupported,
} from "../model-reasoning-effort";

describe("chat reasoning effort capabilities", () => {
  it("keeps native CLI choices distinct from model defaults", () => {
    expect(getModelReasoningEfforts("gpt-5.6-sol")).toStrictEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getModelReasoningEfforts("claude-fable-5-1")).toStrictEqual([
      "low",
      "medium",
      "high",
      "extra",
      "max",
      "ultracode",
    ]);
    expect(compatibleReasoningEffort("claude-fable-5-1", "ultracode")).toBe(
      "ultracode",
    );
    expect(compatibleReasoningEffort("gpt-5.6-sol", null)).toBeNull();
    expect(compatibleReasoningEffort("gpt-5.6-sol", undefined)).toBeNull();
  });

  it("resets incompatible choices on a model change", () => {
    expect(compatibleReasoningEffort("gpt-6-astra", "ultracode")).toBeNull();
    expect(compatibleReasoningEffort("gpt-5.5", "max")).toBeNull();
    expect(compatibleReasoningEffort("claude-sonnet-4-6", "extra")).toBeNull();
    expect(compatibleReasoningEffort("claude-sonnet-5", "xhigh")).toBeNull();
    expect(compatibleReasoningEffort("gpt-6-astra", "extra")).toBeNull();
    expect(compatibleReasoningEffort("claude-sonnet-5", "extra")).toBe("extra");
    expect(compatibleReasoningEffort("gpt-6-astra", "xhigh")).toBe("xhigh");
    expect(compatibleReasoningEffort("claude-sonnet-5", "high")).toBe("high");
    expect(compatibleReasoningEffort("deepseek-v4-flash", "high")).toBeNull();
  });

  it("recognizes native and provider-prefixed model identities", () => {
    expect(getModelReasoningEfforts("openai/gpt-5.6-terra")).toStrictEqual(
      getModelReasoningEfforts("gpt-5.6-terra"),
    );
    expect(
      getModelReasoningEfforts("anthropic/claude-fable-5.1"),
    ).toStrictEqual(getModelReasoningEfforts("claude-fable-5-1"));
    expect(
      isModelReasoningEffortSupported("anthropic/claude-sonnet-4.6", "max"),
    ).toBe(true);
    expect(getModelReasoningEfforts("claude-fable-5")).toStrictEqual([]);
    expect(getModelReasoningEfforts("future-model")).toStrictEqual([]);
  });

  it("preserves omission, reset, and Fast independently on the wire", () => {
    const schema = chatThreadModelSelectionContract.update.body;
    expect(schema.parse({ model: "gpt-5.6-sol" })).not.toHaveProperty(
      "reasoningEffort",
    );
    expect(
      schema.parse({
        model: "gpt-5.6-sol",
        reasoningEffort: null,
        codexServiceTier: "fast",
      }),
    ).toMatchObject({ reasoningEffort: null, codexServiceTier: "fast" });
    expect(
      schema.safeParse({ model: "gpt-5.6-sol", reasoningEffort: "none" })
        .success,
    ).toBe(false);
    const message = {
      agentId: "agent-1",
      prompt: "Task",
      hasTextContent: true,
      userMessage: { version: 1, parts: [{ type: "text", text: "Task" }] },
    };
    expect(chatEventsContract.send.body.parse(message)).not.toHaveProperty(
      "runOptions",
    );
    expect(
      chatEventsContract.send.body.parse({
        ...message,
        runOptions: { reasoningEffort: "low", codexServiceTier: "fast" },
      }),
    ).toMatchObject({
      runOptions: { reasoningEffort: "low", codexServiceTier: "fast" },
    });
  });
});
