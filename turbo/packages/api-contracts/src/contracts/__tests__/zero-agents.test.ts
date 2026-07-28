import { describe, expect, it } from "vitest";

import { zeroAgentDraftResponseSchema } from "../zero-agents";

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
});
