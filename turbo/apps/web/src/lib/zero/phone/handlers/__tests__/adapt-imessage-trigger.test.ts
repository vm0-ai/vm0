import { describe, it, expect } from "vitest";
import { adaptImessageTrigger } from "../adapt-imessage-trigger";
import type { IMessageCallbackPayload } from "../../../../infra/callback/callback-payloads";

const baseCallback: IMessageCallbackPayload = {
  messageId: "msg-1",
  fromNumber: "+15551234567",
  userId: "user-1",
  orgId: "org-1",
  agentId: "agent-1",
  agentphoneAgentId: "ap-agent-1",
  existingSessionId: null,
};

describe("adaptImessageTrigger", () => {
  it("maps a full context to CreateZeroRunParams", () => {
    const result = adaptImessageTrigger({
      agentId: "agent-1",
      sessionId: "sess-1",
      prompt: "hello",
      fromNumber: "+15551234567",
      userId: "user-1",
      callbackContext: baseCallback,
    });

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.sessionId).toBe("sess-1");
    expect(result.prompt).toBe("hello");
    expect(result.triggerSource).toBe("imessage");
    expect(result.appendSystemPrompt).toContain("iMessage");
    expect(result.appendSystemPrompt).toContain("+15551234567");

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/imessage$/);
    expect(typeof callback.secret).toBe("string");
    expect(callback.secret.length).toBeGreaterThan(0);
    expect(callback.payload).toBe(baseCallback);
  });

  it("passes sessionId through as undefined", () => {
    const result = adaptImessageTrigger({
      agentId: "agent-1",
      sessionId: undefined,
      prompt: "hi",
      fromNumber: "+1",
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
      fromNumber: "+1",
      userId: "user-1",
      callbackContext: baseCallback,
    };
    const a = adaptImessageTrigger(ctx);
    const b = adaptImessageTrigger(ctx);
    const aSecret = a.callbacks?.[0]?.secret;
    const bSecret = b.callbacks?.[0]?.secret;
    expect(aSecret).toBeDefined();
    expect(bSecret).toBeDefined();
    expect(aSecret).not.toBe(bSecret);
  });
});
