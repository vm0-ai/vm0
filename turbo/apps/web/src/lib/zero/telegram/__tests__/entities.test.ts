import { describe, it, expect } from "vitest";
import {
  extractTelegramMessageEntities,
  formatCurrentTelegramEntitiesForPrompt,
  formatTelegramEntitiesForContext,
} from "../entities";

describe("formatTelegramEntitiesForContext", () => {
  it("should format mentions, commands, and links", () => {
    const text = "/deploy @alice docs";
    const result = formatTelegramEntitiesForContext(text, [
      { type: "bot_command", offset: 0, length: 7 },
      { type: "mention", offset: 8, length: 6 },
      { type: "text_link", offset: 15, length: 4, url: "https://docs.test" },
    ]);

    expect(result).toBe(
      'bot_command /deploy; mention @alice; text_link "docs" -> https://docs.test',
    );
  });

  it("should include text mention user metadata", () => {
    const result = formatTelegramEntitiesForContext("Ping Alice", [
      {
        type: "text_mention",
        offset: 5,
        length: 5,
        user: {
          id: 123,
          first_name: "Alice",
          username: "alice",
        },
      },
    ]);

    expect(result).toBe(
      'text_mention "Alice" -> {id: 123, username: @alice, name: Alice}',
    );
  });

  it("should keep rich style entities visible", () => {
    const result = formatTelegramEntitiesForContext("const x = 1", [
      { type: "code", offset: 0, length: 11 },
    ]);

    expect(result).toBe('code "const x = 1"');
  });
});

describe("extractTelegramMessageEntities", () => {
  it("should choose text entities for text messages", () => {
    const result = extractTelegramMessageEntities({
      text: "hi @alice",
      caption: "caption @bob",
      entities: [{ type: "mention", offset: 3, length: 6 }],
      caption_entities: [{ type: "mention", offset: 8, length: 4 }],
    });

    expect(result).toEqual([{ type: "mention", offset: 3, length: 6 }]);
  });

  it("should choose caption entities when the message has no text", () => {
    const result = extractTelegramMessageEntities({
      caption: "caption @bob",
      caption_entities: [{ type: "mention", offset: 8, length: 4 }],
    });

    expect(result).toEqual([{ type: "mention", offset: 8, length: 4 }]);
  });
});

describe("formatCurrentTelegramEntitiesForPrompt", () => {
  it("should format current message entity context", () => {
    const result = formatCurrentTelegramEntitiesForPrompt({
      text: "see https://example.com",
      entities: [{ type: "url", offset: 4, length: 19 }],
    });

    expect(result).toBe("[Telegram entities]\nurl https://example.com");
  });
});
