import { describe, it, expect } from "vitest";
import {
  formatContextForAgent,
  extractMessageContent,
  parseExplicitAgentSelection,
} from "../context";

describe("Feature: Format Context For Agent", () => {
  describe("Scenario: Format thread messages into context string", () => {
    it("should include all messages with user IDs", () => {
      const messages = [
        { user: "U123", text: "Hello, can you help me?" },
        { user: "U456", text: "Sure, what do you need?" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("## Slack Thread Context");
      expect(result).toContain("[U123]: Hello, can you help me?");
      expect(result).toContain("[U456]: Sure, what do you need?");
    });
  });

  describe("Scenario: Include bot messages in context", () => {
    it("should include bot messages labeled as 'bot'", () => {
      const messages = [
        { user: "U123", text: "Hello" },
        { bot_id: "BBOT123", text: "Bot response" },
        { user: "U456", text: "Thanks" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[U123]: Hello");
      expect(result).toContain("[bot]: Bot response");
      expect(result).toContain("[U456]: Thanks");
    });

    it("should not filter out any messages even when botUserId is provided", () => {
      const botUserId = "BBOT123";
      const messages = [
        { user: "U123", text: "User message 1" },
        { user: "BBOT123", text: "Bot message" },
        { user: "U456", text: "User message 2" },
      ];

      const result = formatContextForAgent(messages, botUserId);

      // All messages should be included
      expect(result).toContain("[U123]: User message 1");
      expect(result).toContain("[BBOT123]: Bot message");
      expect(result).toContain("[U456]: User message 2");
    });
  });

  describe("Scenario: Handle edge cases", () => {
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

  describe("Scenario: Format channel messages", () => {
    it("should use channel context header", () => {
      const messages = [{ user: "U123", text: "Recent message" }];

      const result = formatContextForAgent(messages, undefined, "channel");

      expect(result).toContain("## Recent Channel Messages");
      expect(result).toContain("[U123]: Recent message");
    });
  });
});

describe("Feature: Extract Message Content", () => {
  describe("Scenario: Remove bot mention from message", () => {
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
});

describe("Feature: Parse Explicit Agent Selection", () => {
  describe("Scenario: Parse 'use <agent>' pattern", () => {
    it("should parse agent name and remaining message", () => {
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

    it("should handle agent name only (no remaining message)", () => {
      const message = "use github-agent";

      const result = parseExplicitAgentSelection(message);

      expect(result).toEqual({
        agentName: "github-agent",
        remainingMessage: "",
      });
    });
  });

  describe("Scenario: Handle invalid patterns", () => {
    it("should return null for messages without 'use' pattern", () => {
      const message = "just a regular message";

      const result = parseExplicitAgentSelection(message);

      expect(result).toBeNull();
    });

    it("should return null for 'use' without agent name", () => {
      const message = "use ";

      const result = parseExplicitAgentSelection(message);

      expect(result).toBeNull();
    });
  });
});
