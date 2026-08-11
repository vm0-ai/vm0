import type { PresentationTemplateSummary } from "@vm0/api-contracts/contracts/zero-presentation-templates";
import { presentationTemplates } from "@vm0/db/schema/presentation-template";
import { and, desc, eq } from "drizzle-orm";

import { buildFileUrlFromKey } from "../../lib/file-url";
import type { ReadonlyDb } from "../external/db";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

export function presentationTemplateSummary(
  row: PresentationTemplateRow,
): PresentationTemplateSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    error: row.error ?? null,
    sourceFilename: row.sourceFilename,
    coverUrl: row.pageKeys[0] ? buildFileUrlFromKey(row.pageKeys[0]) : null,
    pageCount: row.pageKeys.length,
    aspectRatio: row.aspectRatio ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadOwnedPresentationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly templateId: string;
  },
): Promise<PresentationTemplateRow | null> {
  const [row] = await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.id, args.templateId),
        eq(presentationTemplates.orgId, args.orgId),
        eq(presentationTemplates.ownerUserId, args.ownerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listOwnedPresentationTemplates(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly ownerUserId: string },
): Promise<readonly PresentationTemplateRow[]> {
  return await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.orgId, args.orgId),
        eq(presentationTemplates.ownerUserId, args.ownerUserId),
      ),
    )
    .orderBy(desc(presentationTemplates.createdAt));
}
