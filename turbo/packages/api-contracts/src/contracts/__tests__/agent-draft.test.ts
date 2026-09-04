import { describe, expect, it } from "vitest";

import {
  agentDraftRequestSchema,
  agentDraftResponseSchema,
} from "../agent-draft";

describe("agent draft contract", () => {
  it("rejects agent drafts that only carry the retired rich-input field", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Resume agent work" }],
    };

    expect(
      agentDraftResponseSchema.safeParse({
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
      draftVoice: null,
      draftAttachments: null,
    };

    expect(agentDraftResponseSchema.parse(response)).toStrictEqual(response);
  });

  it("requires userMessage for non-empty agent drafts", () => {
    expect(
      agentDraftRequestSchema.safeParse({
        draftUserMessage: null,
        draftAttachments: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      agentDraftRequestSchema.safeParse({
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
