import { describe, it, expect } from "vitest";
import { adaptPhoneTrigger } from "../adapt-phone-trigger";
import type { PhoneCallbackPayload } from "../../../../infra/callback/callback-payloads";

const baseCallback: PhoneCallbackPayload = {
  callId: "call-1",
  userId: "user-1",
  orgId: "org-1",
  agentId: "agent-1",
  existingSessionId: null,
};

describe("adaptPhoneTrigger", () => {
  it("maps a full context to CreateZeroRunParams", () => {
    const result = adaptPhoneTrigger({
      agentId: "agent-1",
      sessionId: "sess-1",
      prompt: "transcript",
      phoneContext: "# Phone Call Context\nCaller: +1",
      userId: "user-1",
      callbackContext: baseCallback,
    });

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.sessionId).toBe("sess-1");
    expect(result.prompt).toBe("transcript");
    expect(result.triggerSource).toBe("phone");
    expect(result.appendSystemPrompt).toContain("Phone");

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/phone$/);
    expect(typeof callback.secret).toBe("string");
    expect(callback.secret.length).toBeGreaterThan(0);
    expect(callback.payload).toBe(baseCallback);
  });

  it("coerces empty appendSystemPrompt to undefined", () => {
    const result = adaptPhoneTrigger({
      agentId: "agent-1",
      sessionId: undefined,
      prompt: "hi",
      phoneContext: "",
      userId: "user-1",
      callbackContext: baseCallback,
    });

    if (result.appendSystemPrompt !== undefined) {
      expect(result.appendSystemPrompt).not.toBe("");
    }
  });

  it("passes sessionId through as undefined", () => {
    const result = adaptPhoneTrigger({
      agentId: "agent-1",
      sessionId: undefined,
      prompt: "hi",
      phoneContext: "ctx",
      userId: "user-1",
      callbackContext: baseCallback,
    });
    expect(result.sessionId).toBeUndefined();
  });

  it("generates a unique secret per call", () => {
    const ctx = {
      agentId: "agent-1",
      sessionId: undefined,
      prompt: "hi",
      phoneContext: "ctx",
      userId: "user-1",
      callbackContext: baseCallback,
    };
    const a = adaptPhoneTrigger(ctx);
    const b = adaptPhoneTrigger(ctx);
    const aSecret = a.callbacks?.[0]?.secret;
    const bSecret = b.callbacks?.[0]?.secret;
    expect(aSecret).toBeDefined();
    expect(bSecret).toBeDefined();
    expect(aSecret).not.toBe(bSecret);
  });
});
