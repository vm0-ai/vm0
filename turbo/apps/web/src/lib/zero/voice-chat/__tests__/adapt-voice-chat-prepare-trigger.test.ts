import { describe, it, expect } from "vitest";
import { adaptVoiceChatPrepareTrigger } from "../adapt-voice-chat-prepare-trigger";

const baseCtx = {
  userId: "user-1",
  agentId: "agent-1",
  prompt: "prepare a voice chat briefing",
  appendSystemPrompt: "# Voice Chat Preparation\nDo the thing.",
  preparationId: "prep-1",
};

describe("adaptVoiceChatPrepareTrigger", () => {
  it("propagates identity fields verbatim", () => {
    const result = adaptVoiceChatPrepareTrigger(baseCtx);

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.prompt).toBe("prepare a voice chat briefing");
    expect(result.appendSystemPrompt).toBe(
      "# Voice Chat Preparation\nDo the thing.",
    );
  });

  it("sets triggerSource to 'voice-chat'", () => {
    const result = adaptVoiceChatPrepareTrigger(baseCtx);
    expect(result.triggerSource).toBe("voice-chat");
  });

  it("builds the prepare callback URL and payload", () => {
    const result = adaptVoiceChatPrepareTrigger(baseCtx);

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(
      /\/api\/internal\/callbacks\/voice-chat-prepare$/,
    );
    expect(callback.payload).toEqual({ preparationId: "prep-1" });
  });

  it("emits exactly one callback", () => {
    const result = adaptVoiceChatPrepareTrigger(baseCtx);
    expect(result.callbacks).toHaveLength(1);
  });

  it("generates a unique secret per invocation", () => {
    const a = adaptVoiceChatPrepareTrigger(baseCtx);
    const b = adaptVoiceChatPrepareTrigger(baseCtx);
    const aSecret = a.callbacks?.[0]?.secret;
    const bSecret = b.callbacks?.[0]?.secret;
    expect(aSecret).toBeDefined();
    expect(bSecret).toBeDefined();
    expect(aSecret).not.toBe(bSecret);
  });

  it("produces a fresh payload object per invocation", () => {
    const a = adaptVoiceChatPrepareTrigger(baseCtx);
    const b = adaptVoiceChatPrepareTrigger(baseCtx);
    expect(a.callbacks?.[0]?.payload).not.toBe(b.callbacks?.[0]?.payload);
  });

  it("returns a non-empty string secret", () => {
    const result = adaptVoiceChatPrepareTrigger(baseCtx);
    const secret = result.callbacks?.[0]?.secret;
    expect(typeof secret).toBe("string");
    expect(secret && secret.length).toBeGreaterThan(0);
  });
});
