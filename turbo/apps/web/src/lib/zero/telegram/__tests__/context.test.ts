import { describe, it, expect, beforeEach } from "vitest";
import { fetchTelegramContext } from "../context";
import { uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTelegramInstallation,
  insertTelegramMessage,
} from "../../../../__tests__/api-test-helpers";

describe("fetchTelegramContext", () => {
  let installationId: string;

  beforeEach(async () => {
    installationId = await createTelegramInstallation();
  });

  it("should return empty context when no messages exist", async () => {
    const result = await fetchTelegramContext(installationId, "chat-1");

    expect(result.executionContext).toBe("");
  });

  it("should return messages in chronological order", async () => {
    const chatId = uniqueId("chat");

    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "1",
      fromUserId: "111",
      fromUsername: "alice",
      text: "First message",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "2",
      fromUserId: "222",
      fromUsername: "bob",
      text: "Second message",
      createdAt: new Date(Date.now() - 30_000),
    });

    const result = await fetchTelegramContext(installationId, chatId);

    expect(result.executionContext).toContain("First message");
    expect(result.executionContext).toContain("SENDER_ID: alice");
    expect(result.executionContext).toContain("Second message");
    expect(result.executionContext).toContain("SENDER_ID: bob");

    const firstIdx = result.executionContext.indexOf("First message");
    const secondIdx = result.executionContext.indexOf("Second message");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("should filter execution context by lastProcessedMessageId", async () => {
    const chatId = uniqueId("chat");

    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "10",
      fromUserId: "111",
      fromUsername: "alice",
      text: "Old message",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "20",
      fromUserId: "222",
      fromUsername: "bob",
      text: "New message",
      createdAt: new Date(Date.now() - 30_000),
    });

    const result = await fetchTelegramContext(installationId, chatId, "10");

    // Execution context only includes messages after ID 10
    expect(result.executionContext).not.toContain("Old message");
    expect(result.executionContext).toContain("New message");
  });

  it("should return empty execution context when no new messages after lastProcessedMessageId", async () => {
    const chatId = uniqueId("chat");

    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "5",
      fromUserId: "111",
      fromUsername: "alice",
      text: "Only message",
      createdAt: new Date(Date.now() - 60_000),
    });

    const result = await fetchTelegramContext(installationId, chatId, "5");

    expect(result.executionContext).toBe("");
  });

  it("should only return messages for the specified chat", async () => {
    const chatA = uniqueId("chatA");
    const chatB = uniqueId("chatB");

    await insertTelegramMessage({
      installationId,
      chatId: chatA,
      messageId: "1",
      fromUserId: "111",
      fromUsername: "alice",
      text: "Chat A message",
    });
    await insertTelegramMessage({
      installationId,
      chatId: chatB,
      messageId: "2",
      fromUserId: "222",
      fromUsername: "bob",
      text: "Chat B message",
    });

    const result = await fetchTelegramContext(installationId, chatA);

    expect(result.executionContext).toContain("Chat A message");
    expect(result.executionContext).not.toContain("Chat B message");
  });

  it("should include bot messages in context", async () => {
    const chatId = uniqueId("chat");

    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "1",
      fromUserId: "111",
      fromUsername: "alice",
      text: "User message",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertTelegramMessage({
      installationId,
      chatId,
      messageId: "2",
      fromUserId: "999",
      fromUsername: "test_bot",
      text: "Bot reply",
      isBot: true,
      createdAt: new Date(Date.now() - 30_000),
    });

    const result = await fetchTelegramContext(installationId, chatId);

    expect(result.executionContext).toContain("User message");
    expect(result.executionContext).toContain("SENDER_ID: BOT");
    expect(result.executionContext).toContain("Bot reply");
  });
});
