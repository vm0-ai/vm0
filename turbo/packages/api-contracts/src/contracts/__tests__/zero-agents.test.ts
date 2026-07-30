import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  persistedAttachmentSchema,
  userMessageDocumentSchema,
} from "../chat-threads";
import {
  zeroAgentDraftRequestSchema,
  zeroAgentDraftResponseSchema,
} from "../zero-agents";

const previousZeroAgentDraftResponseSchema = z.object({
  draftContent: z.string().nullable(),
  draftUserMessage: userMessageDocumentSchema.nullable(),
  draftAttachments: z.array(persistedAttachmentSchema).nullable(),
});

describe("zero agent draft contract", () => {
  it("rejects agent drafts that only carry the retired rich-input field", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Resume agent work" }],
    };

    expect(
      zeroAgentDraftResponseSchema.safeParse({
        draftContent: null,
        draftStructuredPrompt: userMessage,
        draftAttachments: null,
      }).success,
    ).toBe(false);
  });

  it("keeps agent draft responses readable by the previous App schema", () => {
    const response = zeroAgentDraftResponseSchema.parse({
      draftContent: null,
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Resume agent work" }],
      },
      draftAttachments: null,
    });

    expect(previousZeroAgentDraftResponseSchema.parse(response)).toStrictEqual(
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
