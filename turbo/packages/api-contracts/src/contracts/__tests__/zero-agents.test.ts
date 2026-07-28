import { describe, expect, it } from "vitest";

import {
  zeroAgentDraftRequestSchema,
  zeroAgentDraftResponseSchema,
} from "../zero-agents";

describe("zero agent draft contract", () => {
  it("normalizes the preceding agent draft response", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Resume agent work" }],
    };

    expect(
      zeroAgentDraftResponseSchema.parse({
        draftContent: "Resume agent work",
        draftStructuredPrompt: userMessage,
        draftAttachments: null,
      }),
    ).toStrictEqual({
      draftContent: "Resume agent work",
      draftUserMessage: userMessage,
      draftAttachments: null,
    });
  });

  it("requires userMessage for non-empty agent drafts", () => {
    expect(
      zeroAgentDraftRequestSchema.safeParse({
        draftContent: null,
        draftUserMessage: null,
        draftAttachments: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      zeroAgentDraftRequestSchema.safeParse({
        draftContent: null,
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
