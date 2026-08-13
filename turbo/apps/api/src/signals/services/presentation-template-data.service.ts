import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { zeroRuns } from "@okouai/db/schema/zero-run";
import { and, desc, eq } from "drizzle-orm";

import { buildFileUrlFromKey } from "../../lib/file-url";
import type { ReadonlyDb } from "../external/db";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

function presentationTemplateIdFromVars(vars: unknown): string | null {
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    return null;
  }
  const templateId = Reflect.get(vars, "PRESENTATION_TEMPLATE_ID");
  return typeof templateId === "string" ? templateId : null;
}

export function presentationTemplateSummary(
  row: PresentationTemplateRow,
): PresentationTemplateSummary {
  const visiblePageKeys =
    row.status === "processing" || row.status === "ready" ? row.pageKeys : [];
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    error: row.error,
    sourceFilename: row.sourceFilename,
    coverUrl: visiblePageKeys[0]
      ? buildFileUrlFromKey(visiblePageKeys[0])
      : null,
    pageCount: visiblePageKeys.length,
    aspectRatio: row.aspectRatio,
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

export async function loadRunOwnedPresentationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly runId: string;
    readonly templateId: string;
  },
): Promise<PresentationTemplateRow | null> {
  const [run] = await db
    .select({
      vars: agentRuns.vars,
      triggerSource: zeroRuns.triggerSource,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.ownerUserId),
      ),
    )
    .limit(1);
  if (
    run?.triggerSource !== "template-import" ||
    presentationTemplateIdFromVars(run.vars) !== args.templateId
  ) {
    return null;
  }
  return await loadOwnedPresentationTemplate(db, {
    orgId: args.orgId,
    ownerUserId: args.ownerUserId,
    templateId: args.templateId,
  });
}

export async function loadPresentationTemplateImportRun(
  db: ReadonlyDb,
  args: { readonly runId: string; readonly templateId: string },
): Promise<{
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly template: PresentationTemplateRow | null;
} | null> {
  const [run] = await db
    .select({
      orgId: agentRuns.orgId,
      ownerUserId: agentRuns.userId,
      vars: agentRuns.vars,
      triggerSource: zeroRuns.triggerSource,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  if (
    run?.triggerSource !== "template-import" ||
    presentationTemplateIdFromVars(run.vars) !== args.templateId
  ) {
    return null;
  }
  return {
    orgId: run.orgId,
    ownerUserId: run.ownerUserId,
    template: await loadOwnedPresentationTemplate(db, {
      orgId: run.orgId,
      ownerUserId: run.ownerUserId,
      templateId: args.templateId,
    }),
  };
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
