import { command } from "ccstate";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import { deletePresentationTemplateObjects$ } from "./presentation-template-object.service";

export const deletePresentationTemplate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const template = await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const [row] = await tx
        .select({ id: presentationTemplates.id })
        .from(presentationTemplates)
        .where(
          and(
            eq(presentationTemplates.id, args.templateId),
            eq(presentationTemplates.orgId, args.orgId),
            eq(presentationTemplates.ownerUserId, args.ownerUserId),
            inArray(presentationTemplates.status, ["pending", "failed"]),
          ),
        )
        .limit(1);
      if (!row) {
        return null;
      }
      await tx
        .update(presentationTemplates)
        .set({
          status: "failed",
          updatedAt: nowDate(),
          updatedBy: args.ownerUserId,
        })
        .where(eq(presentationTemplates.id, row.id));
      return row;
    });
    signal.throwIfAborted();
    if (!template) {
      return false;
    }

    await set(deletePresentationTemplateObjects$, template.id, signal);
    const [deleted] = await db
      .delete(presentationTemplates)
      .where(
        and(
          eq(presentationTemplates.id, template.id),
          eq(presentationTemplates.orgId, args.orgId),
          eq(presentationTemplates.ownerUserId, args.ownerUserId),
          eq(presentationTemplates.status, "failed"),
        ),
      )
      .returning({ id: presentationTemplates.id });
    signal.throwIfAborted();
    return deleted !== undefined;
  },
);
