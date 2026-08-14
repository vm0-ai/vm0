import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, desc, eq, ne } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { ReadonlyDb } from "../external/db";

const PREPARATION_ID_NAMESPACE = "89c6526f-2624-43b1-91dc-c5a37dd0041b";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

export function presentationTemplateIdForRequest(args: {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
}): string {
  return uuidv5(
    `${args.orgId}:${args.ownerUserId}:${args.requestId}`,
    PREPARATION_ID_NAMESPACE,
  );
}

export function presentationTemplateSummary(
  row: PresentationTemplateRow,
  coverUrl: string | null,
): PresentationTemplateSummary {
  const hasCommittedPages =
    row.status === "processing" || row.status === "ready";
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    error: row.error,
    sourceFilename: row.sourceFilename,
    coverUrl: hasCommittedPages ? coverUrl : null,
    pageCount: hasCommittedPages ? row.pageKeys.length : 0,
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
        ne(presentationTemplates.status, "pending"),
      ),
    )
    .orderBy(desc(presentationTemplates.createdAt));
}
