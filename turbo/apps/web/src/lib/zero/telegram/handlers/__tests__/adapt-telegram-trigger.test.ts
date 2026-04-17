import { describe, it, expect } from "vitest";
import { adaptTelegramTrigger } from "../adapt-telegram-trigger";
import type { TelegramCallbackPayload } from "../../../../infra/callback/callback-payloads";

const baseCallback: TelegramCallbackPayload = {
  installationId: "inst-1",
  chatId: "chat-1",
  messageId: "msg-1",
  rootMessageId: null,
  userLinkId: "link-1",
  agentId: "compose-1",
  existingSessionId: null,
  isDM: false,
  thinkingMessageId: null,
};

describe("adaptTelegramTrigger", () => {
  it("maps a full context to CreateZeroRunParams", () => {
    const result = adaptTelegramTrigger({
      agentId: "agent-1",
      sessionId: "sess-1",
      prompt: "hello",
      threadContext: "previous message\nanother",
      userId: "user-1",
      callbackContext: baseCallback,
    });

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.sessionId).toBe("sess-1");
    expect(result.prompt).toBe("hello");
    expect(result.triggerSource).toBe("telegram");
    expect(result.appendSystemPrompt).toContain("Telegram");

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/telegram$/);
    expect(typeof callback.secret).toBe("string");
    expect(callback.secret.length).toBeGreaterThan(0);
    expect(callback.payload).toBe(baseCallback);
  });

  it("coerces empty appendSystemPrompt to undefined", () => {
    const result = adaptTelegramTrigger({
      agentId: "agent-1",
      sessionId: undefined,
      prompt: "hi",
      threadContext: "",
      userId: "user-1",
      callbackContext: baseCallback,
    });

    // The `|| undefined` coercion rule: appendSystemPrompt is never "".
    if (result.appendSystemPrompt !== undefined) {
      expect(result.appendSystemPrompt).not.toBe("");
    }
  });

  it("passes sessionId through as undefined", () => {
    const result = adaptTelegramTrigger({
      agentId: "agent-1",
      sessionId: undefined,
      prompt: "hi",
      threadContext: "ctx",
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
      threadContext: "ctx",
      userId: "user-1",
      callbackContext: baseCallback,
    };
    const a = adaptTelegramTrigger(ctx);
    const b = adaptTelegramTrigger(ctx);
    const aSecret = a.callbacks?.[0]?.secret;
    const bSecret = b.callbacks?.[0]?.secret;
    expect(aSecret).toBeDefined();
    expect(bSecret).toBeDefined();
    expect(aSecret).not.toBe(bSecret);
  });
});
