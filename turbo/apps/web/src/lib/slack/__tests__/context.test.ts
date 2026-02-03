import { describe, it, expect } from "vitest";
import {
  formatContextForAgent,
  extractMessageContent,
  parseExplicitAgentSelection,
} from "../context";

describe("formatContextForAgent", () => {
  it("should format messages into context string", () => {
    const messages = [
      { user: "U123", text: "Hello, can you help me?" },
      { user: "U456", text: "Sure, what do you need?" },
    ];

    const result = formatContextForAgent(messages);
    expect(result).toContain("## Slack Thread Context");
    expect(result).toContain("[U123]: Hello, can you help me?");
    expect(result).toContain("[U456]: Sure, what do you need?");
  });

  it("should filter out bot messages when botUserId is provided", () => {
    const botUserId = "BBOT123";
    const messages = [
      { user: "U123", text: "Hello" },
      { user: "BBOT123", text: "Bot response" },
      { user: "U456", text: "Thanks" },
    ];

    const result = formatContextForAgent(messages, botUserId);
    expect(result).toContain("[U123]: Hello");
    expect(result).not.toContain("Bot response");
    expect(result).toContain("[U456]: Thanks");
  });

  it("should return empty string for empty messages array", () => {
    const result = formatContextForAgent([]);
    expect(result).toBe("");
  });

  it("should handle messages with missing user or text", () => {
    const messages = [{ text: "No user" }, { user: "U123" }];

    const result = formatContextForAgent(messages);
    expect(result).toContain("[unknown]: No user");
    expect(result).toContain("[U123]: ");
  });
});

describe("extractMessageContent", () => {
  it("should remove bot mention from beginning of message", () => {
    const botUserId = "U12345678";
    const text = "<@U12345678> help me with this code";

    const result = extractMessageContent(text, botUserId);
    expect(result).toBe("help me with this code");
  });

  it("should handle message with only mention", () => {
    const botUserId = "U12345678";
    const text = "<@U12345678>";

    const result = extractMessageContent(text, botUserId);
    expect(result).toBe("");
  });

  it("should handle message without mention", () => {
    const botUserId = "U12345678";
    const text = "just a regular message";

    const result = extractMessageContent(text, botUserId);
    expect(result).toBe("just a regular message");
  });

  it("should trim whitespace", () => {
    const botUserId = "U12345678";
    const text = "<@U12345678>    hello    ";

    const result = extractMessageContent(text, botUserId);
    expect(result).toBe("hello");
  });
});

describe("parseExplicitAgentSelection", () => {
  it("should parse 'use <agent>' pattern", () => {
    const message = "use my-coder fix this bug";

    const result = parseExplicitAgentSelection(message);
    expect(result).toEqual({
      agentName: "my-coder",
      remainingMessage: "fix this bug",
    });
  });

  it("should be case insensitive", () => {
    const message = "USE My-Agent do something";

    const result = parseExplicitAgentSelection(message);
    expect(result).toEqual({
      agentName: "My-Agent",
      remainingMessage: "do something",
    });
  });

  it("should return null for messages without 'use' pattern", () => {
    const message = "just a regular message";

    const result = parseExplicitAgentSelection(message);
    expect(result).toBeNull();
  });

  it("should handle agent name only (no remaining message)", () => {
    const message = "use github-agent";

    const result = parseExplicitAgentSelection(message);
    expect(result).toEqual({
      agentName: "github-agent",
      remainingMessage: "",
    });
  });

  it("should return null for 'use' without agent name", () => {
    const message = "use ";

    const result = parseExplicitAgentSelection(message);
    expect(result).toBeNull();
  });
});
