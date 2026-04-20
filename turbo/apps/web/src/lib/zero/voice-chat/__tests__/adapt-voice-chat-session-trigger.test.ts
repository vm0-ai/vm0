import { describe, it, expect } from "vitest";
import { adaptVoiceChatSessionTrigger } from "../adapt-voice-chat-session-trigger";

const baseCtx = {
  userId: "user-1",
  agentId: "agent-1",
  prompt: "observe the voice-chat conversation",
  appendSystemPrompt: "# Voice Chat Session\nStart observing.",
  sessionId: "sess-1",
  apiStartTime: 1000,
};

describe("adaptVoiceChatSessionTrigger", () => {
  it("propagates identity fields verbatim", () => {
    const result = adaptVoiceChatSessionTrigger(baseCtx);

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.prompt).toBe("observe the voice-chat conversation");
    expect(result.appendSystemPrompt).toBe(
      "# Voice Chat Session\nStart observing.",
    );
  });

  it("sets triggerSource to 'voice-chat'", () => {
    const result = adaptVoiceChatSessionTrigger(baseCtx);
    expect(result.triggerSource).toBe("voice-chat");
  });

  it("forwards apiStartTime", () => {
    const result = adaptVoiceChatSessionTrigger(baseCtx);
    expect(result.apiStartTime).toBe(1000);
  });

  it("builds the session callback URL and payload", () => {
    const result = adaptVoiceChatSessionTrigger(baseCtx);

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/voice-chat$/);
    expect(callback.payload).toEqual({ sessionId: "sess-1" });
  });

  it("emits exactly one callback", () => {
    const result = adaptVoiceChatSessionTrigger(baseCtx);
    expect(result.callbacks).toHaveLength(1);
  });

  it("generates a unique secret per invocation", () => {
    const a = adaptVoiceChatSessionTrigger(baseCtx);
    const b = adaptVoiceChatSessionTrigger(baseCtx);
    const aSecret = a.callbacks?.[0]?.secret;
    const bSecret = b.callbacks?.[0]?.secret;
    expect(aSecret).toBeDefined();
    expect(bSecret).toBeDefined();
    expect(aSecret).not.toBe(bSecret);
  });

  it("produces a fresh payload object per invocation", () => {
    const a = adaptVoiceChatSessionTrigger(baseCtx);
    const b = adaptVoiceChatSessionTrigger(baseCtx);
    expect(a.callbacks?.[0]?.payload).not.toBe(b.callbacks?.[0]?.payload);
  });

  it("returns a non-empty string secret", () => {
    const result = adaptVoiceChatSessionTrigger(baseCtx);
    const secret = result.callbacks?.[0]?.secret;
    expect(typeof secret).toBe("string");
    expect(secret && secret.length).toBeGreaterThan(0);
  });
});
