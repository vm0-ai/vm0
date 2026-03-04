import { describe, it, expect, beforeEach } from "vitest";
import { formatContextForAgent, fetchTelegramContext } from "../context";
import { uniqueId } from "../../../__tests__/test-helpers";
import { createTelegramInstallation, insertTelegramMessage } from "./helpers";

describe("formatContextForAgent", () => {
  it("should return empty string for empty messages", () => {
    expect(formatContextForAgent([])).toBe("");
  });

  it("should format messages with username", () => {
    const messages = [
      {
        fromUsername: "alice",
        fromUserId: "111",
        text: "Hello",
        isBot: false,
        messageId: "1",
      },
    ];

    const result = formatContextForAgent(messages);

    expect(result).toContain("# Telegram Chat Context");
    expect(result).toContain("[alice]: Hello");
  });

  it("should fall back to user ID when username is null", () => {
    const messages = [
      {
        fromUsername: null,
        fromUserId: "222",
        text: "Hi there",
        isBot: false,
        messageId: "2",
      },
    ];

    const result = formatContextForAgent(messages);

    expect(result).toContain("[user:222]: Hi there");
  });

  it("should label bot messages as BOT", () => {
    const messages = [
      {
        fromUsername: "my_bot",
        fromUserId: "333",
        text: "I am a bot",
        isBot: true,
        messageId: "3",
      },
    ];

    const result = formatContextForAgent(messages);

    expect(result).toContain("[BOT]: I am a bot");
  });

  it("should filter out messages with null text", () => {
    const messages = [
      {
        fromUsername: "alice",
        fromUserId: "111",
        text: null,
        isBot: false,
        messageId: "1",
      },
      {
        fromUsername: "bob",
        fromUserId: "222",
        text: "Visible",
        isBot: false,
        messageId: "2",
      },
    ];

    const result = formatContextForAgent(messages);

    expect(result).not.toContain("[alice]");
    expect(result).toContain("[bob]: Visible");
  });

  it("should include context preamble", () => {
    const messages = [
      {
        fromUsername: "alice",
        fromUserId: "111",
        text: "Hello",
        isBot: false,
        messageId: "1",
      },
    ];

    const result = formatContextForAgent(messages);

    expect(result).toContain("Match the tone of the conversation");
    expect(result).toContain(
      "Only provide technical analysis when explicitly asked",
    );
    expect(result).toContain(
      "Keep responses proportional to the message length",
    );
  });

  it("should format multiple messages in order", () => {
    const messages = [
      {
        fromUsername: "alice",
        fromUserId: "111",
        text: "First",
        isBot: false,
        messageId: "1",
      },
      {
        fromUsername: null,
        fromUserId: "222",
        text: "Second",
        isBot: false,
        messageId: "2",
      },
      {
        fromUsername: "bot",
        fromUserId: "333",
        text: "Third",
        isBot: true,
        messageId: "3",
      },
    ];

    const result = formatContextForAgent(messages);

    const lines = result.split("\n");
    const aliceLine = lines.findIndex((l) => l.includes("[alice]: First"));
    const userLine = lines.findIndex((l) => l.includes("[user:222]: Second"));
    const botLine = lines.findIndex((l) => l.includes("[BOT]: Third"));

    expect(aliceLine).toBeLessThan(userLine);
    expect(userLine).toBeLessThan(botLine);
  });
});

describe("fetchTelegramContext", () => {
  let installationId: string;

  beforeEach(async () => {
    installationId = await createTelegramInstallation();
  });

  it("should return empty context when no messages exist", async () => {
    const result = await fetchTelegramContext(installationId, "chat-1");

    expect(result.routingContext).toBe("");
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

    expect(result.routingContext).toContain("[alice]: First message");
    expect(result.routingContext).toContain("[bob]: Second message");

    const firstIdx = result.routingContext.indexOf("[alice]: First message");
    const secondIdx = result.routingContext.indexOf("[bob]: Second message");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("should split routing and execution context by lastProcessedMessageId", async () => {
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

    // Routing context includes all messages
    expect(result.routingContext).toContain("[alice]: Old message");
    expect(result.routingContext).toContain("[bob]: New message");

    // Execution context only includes messages after ID 10
    expect(result.executionContext).not.toContain("[alice]: Old message");
    expect(result.executionContext).toContain("[bob]: New message");
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

    expect(result.routingContext).toContain("[alice]: Only message");
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

    expect(result.routingContext).toContain("[alice]: Chat A message");
    expect(result.routingContext).not.toContain("[bob]: Chat B message");
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

    expect(result.routingContext).toContain("[alice]: User message");
    expect(result.routingContext).toContain("[BOT]: Bot reply");
  });
});
