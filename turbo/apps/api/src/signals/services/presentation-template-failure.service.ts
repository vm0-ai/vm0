import { command } from "ccstate";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { loadOwnedPresentationTemplate } from "./presentation-template-data.service";
import { deletePresentationTemplatePages$ } from "./presentation-template-page.service";
import { cleanupPresentationTemplatePackage$ } from "./presentation-template-package.service";

type FailPresentationTemplateResult =
  | { readonly kind: "failed"; readonly id: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict"; readonly status: "ready" };

export const failPresentationTemplateImport$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly error: { readonly code: string; readonly message: string };
    },
    signal: AbortSignal,
  ): Promise<FailPresentationTemplateResult> => {
    const db = set(writeDb$);
    const [transitioned] = await db
      .update(presentationTemplates)
      .set({
        status: "failed",
        error: args.error,
        updatedAt: nowDate(),
        updatedBy: args.ownerUserId,
      })
      .where(
        and(
          eq(presentationTemplates.id, args.templateId),
          eq(presentationTemplates.orgId, args.orgId),
          eq(presentationTemplates.ownerUserId, args.ownerUserId),
          inArray(presentationTemplates.status, ["pending", "processing"]),
        ),
      )
      .returning();
    signal.throwIfAborted();

    const template =
      transitioned ??
      (await loadOwnedPresentationTemplate(db, {
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        templateId: args.templateId,
      }));
    signal.throwIfAborted();
    if (!template) {
      return { kind: "not-found" };
    }
    if (template.status === "ready") {
      return { kind: "conflict", status: "ready" };
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
    await db
      .update(presentationTemplates)
      .set({
        pageKeys: [],
        aspectRatio: null,
        updatedAt: nowDate(),
        updatedBy: args.ownerUserId,
      })
      .where(
        and(
          eq(presentationTemplates.id, template.id),
          eq(presentationTemplates.status, "failed"),
        ),
      );
    signal.throwIfAborted();
    return { kind: "failed", id: template.id };
  },
);
