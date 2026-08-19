import { command } from "ccstate";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { presentationTemplateUploads } from "@okouai/db/schema/presentation-template-upload";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";

export const deletePresentationTemplate$ = command(
  async (
    { get, set },
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
        .select({
          id: presentationTemplates.id,
          sourceStorageKey: presentationTemplates.sourceStorageKey,
          pageKeys: presentationTemplates.pageKeys,
        })
        .from(presentationTemplates)
        .where(
          and(
            eq(presentationTemplates.id, args.templateId),
            eq(presentationTemplates.orgId, args.orgId),
            eq(presentationTemplates.ownerUserId, args.ownerUserId),
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

    // Staging rows for an import that never committed cascade with the template
    // row, so their keys have to be collected before it is deleted.
    const staged = await db
      .select({ storageKey: presentationTemplateUploads.storageKey })
      .from(presentationTemplateUploads)
      .where(eq(presentationTemplateUploads.templateId, template.id));
    signal.throwIfAborted();

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
    if (!deleted) {
      return false;
    }

    // The API allocates the source and page objects for one import. Nothing
    // else can reference them and they never enter the artifact catalog, so
    // they are deleted with the template rather than left in the bucket.
    const keys = [
      ...(template.sourceStorageKey === null
        ? []
        : [template.sourceStorageKey]),
      ...template.pageKeys,
      ...staged.map((row) => {
        return row.storageKey;
      }),
    ];
    await get(deleteS3Objects(env("R2_USER_ARTIFACTS_BUCKET_NAME"), keys));
    signal.throwIfAborted();
    return true;
  },
);
