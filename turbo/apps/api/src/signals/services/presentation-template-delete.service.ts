import { command } from "ccstate";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";

interface DeletedPresentationTemplate {
  readonly visibility: "private" | "public";
}

export const deletePresentationTemplate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
    },
    signal: AbortSignal,
  ): Promise<DeletedPresentationTemplate | null> => {
    // Source and page objects are normal user uploads. Deleting a template must
    // not delete independently owned attachments that may be reused elsewhere.
    //
    // Concurrent deletes of the same template need no marker column or advisory
    // lock: the row lock a single `DELETE ... RETURNING` takes already lets
    // exactly one caller observe the row, and the loser returns nothing.
    const [deleted] = await set(writeDb$)
      .delete(presentationTemplates)
      .where(
        and(
          eq(presentationTemplates.id, args.templateId),
          eq(presentationTemplates.orgId, args.orgId),
          eq(presentationTemplates.ownerUserId, args.ownerUserId),
        ),
      )
      .returning({ visibility: presentationTemplates.visibility });
    signal.throwIfAborted();
    return deleted ?? null;
  },
);
