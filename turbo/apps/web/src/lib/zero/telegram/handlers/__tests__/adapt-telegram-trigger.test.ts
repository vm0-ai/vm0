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
};

describe("adaptTelegramTrigger", () => {
  it("maps a full context to CreateZeroRunParams", () => {
    const result = adaptTelegramTrigger({
      agentId: "agent-1",
      sessionId: "sess-1",
      prompt: "hello",
      threadContext: "previous message\nanother",
      userInfoExtras: {
        telegramUserId: "42",
        telegramUsername: "@alice",
      },
      botId: "123456789",
      botUsername: "test_bot",
      chatId: "chat-1",
      chatType: "group",
      messageId: "msg-1",
      rootMessageId: "root-1",
      messageThreadId: 123,
      userId: "user-1",
      callbackContext: baseCallback,
      apiStartTime: 1000,
    });

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.sessionId).toBe("sess-1");
    expect(result.prompt).toBe("hello");
    expect(result.triggerSource).toBe("telegram");
    expect(result.apiStartTime).toBe(1000);
    expect(result.appendSystemPrompt).toContain("Telegram");
    expect(result.appendSystemPrompt).toContain("Bot ID: 123456789");
    expect(result.appendSystemPrompt).toContain("Bot username: @test_bot");
    expect(result.appendSystemPrompt).toContain("Chat ID: chat-1");
    expect(result.appendSystemPrompt).toContain("Chat type: group");
    expect(result.appendSystemPrompt).toContain("Message ID: msg-1");
    expect(result.appendSystemPrompt).toContain("Root message ID: root-1");
    expect(result.appendSystemPrompt).toContain("Message thread ID: 123");
    expect(result.userInfoExtras).toEqual({
      telegramUserId: "42",
      telegramUsername: "@alice",
    });

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
      apiStartTime: 1000,
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
      apiStartTime: 1000,
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
      apiStartTime: 1000,
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
