import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deletePresentationTemplatePages$ } from "./presentation-template-page.service";
import { cleanupPresentationTemplatePackage$ } from "./presentation-template-package.service";

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
    const writeDb = set(writeDb$);
    const template = await writeDb.transaction(async (tx) => {
      const [template] = await tx
        .select({
          id: presentationTemplates.id,
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
        .for("update")
        .limit(1);
      if (!template) {
        return null;
      }
      await tx
        .update(presentationTemplates)
        .set({
          status: "failed",
          updatedAt: nowDate(),
          updatedBy: args.ownerUserId,
        })
        .where(eq(presentationTemplates.id, template.id));
      return template;
    });
    signal.throwIfAborted();
    if (!template) {
      return false;
    }

    await set(
      deletePresentationTemplatePages$,
      { templateId: template.id, storedKeys: template.pageKeys },
      signal,
    );
    await set(
      cleanupPresentationTemplatePackage$,
      { orgId: args.orgId, templateId: template.id },
      signal,
    );
    const [deleted] = await writeDb
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
