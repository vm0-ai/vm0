import { describe, it, expect } from "vitest";
import {
  appendTelegramMessageContext,
  hasTelegramMessageContextContent,
} from "../shared";

describe("hasTelegramMessageContextContent", () => {
  it("should accept supported file-only messages", () => {
    expect(
      hasTelegramMessageContextContent({
        message_id: 1,
        chat: { id: 123, type: "private" },
        document: {
          file_id: "doc_1",
          file_unique_id: "unique_doc_1",
          file_name: "brief.pdf",
          mime_type: "application/pdf",
        },
      }),
    ).toBe(true);
  });

  it("should reject messages without supported content", () => {
    expect(
      hasTelegramMessageContextContent({
        message_id: 1,
        chat: { id: 123, type: "private" },
      }),
    ).toBe(false);
  });
});

describe("appendTelegramMessageContext", () => {
  it("should append document and entity context to the current prompt", () => {
    const result = appendTelegramMessageContext(
      "Please review this",
      {
        message_id: 1,
        chat: { id: 123, type: "private" },
        caption: "Please review this @alice",
        document: {
          file_id: "doc_1",
          file_unique_id: "unique_doc_1",
          file_name: "brief.pdf",
          mime_type: "application/pdf",
          file_size: 1234,
        },
        caption_entities: [{ type: "mention", offset: 19, length: 6 }],
      },
      "bot_1",
    );

    expect(result).toContain("Please review this");
    expect(result).toContain("[Telegram file] brief.pdf (application/pdf)");
    expect(result).not.toContain("[Name] brief.pdf");
    expect(result).toContain("[Telegram entities]\nmention @alice");
  });
});
