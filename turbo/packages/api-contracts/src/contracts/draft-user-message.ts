import type { z } from "zod";

export function requireUserMessageForNonEmptyDraft(
  draft: {
    readonly draftContent?: string | null;
    readonly draftUserMessage: unknown;
    readonly draftAttachments?: readonly unknown[] | null;
  },
  context: z.RefinementCtx,
): void {
  const hasLegacyDraft =
    (draft.draftContent?.length ?? 0) > 0 ||
    (draft.draftAttachments?.length ?? 0) > 0;
  if (hasLegacyDraft && draft.draftUserMessage === null) {
    context.addIssue({
      code: "custom",
      message: "draftUserMessage is required for a non-empty draft",
      path: ["draftUserMessage"],
    });
  }
}
