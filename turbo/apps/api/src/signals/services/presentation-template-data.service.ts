import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/presentation-templates";
import { agentRuns } from "@okouai/db/schema/agent-run-session-conversation";
import { presentationTemplateImportThreads } from "@okouai/db/schema/presentation-template-import-thread";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, desc, eq, ne } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { ReadonlyDb } from "../external/db";

const IMPORT_ID_NAMESPACE = "89c6526f-2624-43b1-91dc-c5a37dd0041b";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

/**
 * Derive the template id from the caller's request id so a resubmitted commit
 * resolves to the same row instead of starting a second import.
 */
export function presentationTemplateIdForRequest(args: {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
}): string {
  return uuidv5(
    `${args.orgId}:${args.ownerUserId}:${args.requestId}`,
    IMPORT_ID_NAMESPACE,
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

/**
 * A run may only reach the import whose analysis thread it belongs to. The
 * thread comes from the run row and the mapping is written before the first
 * message is sent, so neither side of the link is caller-supplied.
 */
export async function loadRunOwnedPresentationTemplate(
  db: ReadonlyDb,
  auth: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
  },
  templateId: string,
): Promise<PresentationTemplateRow | null> {
  const [link] = await db
    .select({ templateId: presentationTemplateImportThreads.templateId })
    .from(agentRuns)
    .innerJoin(
      presentationTemplateImportThreads,
      eq(
        presentationTemplateImportThreads.chatThreadId,
        agentRuns.chatThreadId,
      ),
    )
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
      ),
    )
    .limit(1);
  if (link?.templateId !== templateId) {
    return null;
  }
  return await loadOwnedPresentationTemplate(db, {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId,
  });
}
