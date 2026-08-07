import { describe, expect, it } from "vitest";

import {
  zeroAgentDraftRequestSchema,
  zeroAgentDraftResponseSchema,
} from "../zero-agents";

describe("zero agent draft contract", () => {
  it("rejects agent drafts that only carry the retired rich-input field", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Resume agent work" }],
    };

    expect(
      zeroAgentDraftResponseSchema.safeParse({
        draftStructuredPrompt: userMessage,
        draftAttachments: null,
      }).success,
    ).toBe(false);
  });

  it("accepts canonical agent draft responses", () => {
    const response = {
      draftUserMessage: {
        version: 1 as const,
        parts: [{ type: "text" as const, text: "Resume agent work" }],
      },
      draftAttachments: null,
    };

    expect(zeroAgentDraftResponseSchema.parse(response)).toStrictEqual(
      response,
    );
  });

  it("requires userMessage for non-empty agent drafts", () => {
    expect(
      zeroAgentDraftRequestSchema.safeParse({
        draftUserMessage: null,
        draftAttachments: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      zeroAgentDraftRequestSchema.safeParse({
        draftUserMessage: null,
        draftAttachments: [
          {
            id: "draft-file",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 42,
            url: "https://example.com/brief.md",
          },
        ],
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["draftUserMessage"],
          }),
        ],
      },
    });
  });
});
