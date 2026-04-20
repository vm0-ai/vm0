import { describe, it, expect } from "vitest";
import { formatReplyQuote } from "../shared";

describe("formatReplyQuote", () => {
  it("should return undefined when no reply message", () => {
    expect(formatReplyQuote(undefined)).toBeUndefined();
  });

  it("should return undefined when reply has no text or caption", () => {
    expect(
      formatReplyQuote({ message_id: 1, from: { id: 123 } }),
    ).toBeUndefined();
  });

  it("should format reply with username", () => {
    const result = formatReplyQuote({
      message_id: 1,
      from: { id: 123, username: "alice" },
      text: "Hello world",
    });
    expect(result).toBe("[Replying to @alice]\n> Hello world");
  });

  it("should format reply with first name when no username", () => {
    const result = formatReplyQuote({
      message_id: 1,
      from: { id: 123, first_name: "Alice" },
      text: "Hello world",
    });
    expect(result).toBe("[Replying to Alice]\n> Hello world");
  });

  it("should use caption when text is absent", () => {
    const result = formatReplyQuote({
      message_id: 1,
      from: { id: 123, username: "bob" },
      caption: "Photo caption",
    });
    expect(result).toBe("[Replying to @bob]\n> Photo caption");
  });

  it("should prefer text over caption", () => {
    const result = formatReplyQuote({
      message_id: 1,
      from: { id: 123, username: "bob" },
      text: "Message text",
      caption: "Photo caption",
    });
    expect(result).toBe("[Replying to @bob]\n> Message text");
  });

  it("should use 'Unknown' when from is missing", () => {
    const result = formatReplyQuote({
      message_id: 1,
      text: "Hello",
    });
    expect(result).toBe("[Replying to Unknown]\n> Hello");
  });

  it("should format reply from bot", () => {
    const result = formatReplyQuote({
      message_id: 1,
      from: { id: 999, is_bot: true, username: "my_bot" },
      text: "Bot response",
    });
    expect(result).toBe("[Replying to @my_bot]\n> Bot response");
  });
});
