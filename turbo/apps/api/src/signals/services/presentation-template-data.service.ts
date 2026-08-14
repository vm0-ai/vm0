import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, desc, eq, ne } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { ReadonlyDb } from "../external/db";

const IMPORT_ID_NAMESPACE = "89c6526f-2624-43b1-91dc-c5a37dd0041b";
const ANALYSIS_RUN_ID_NAMESPACE = "46d368f9-e63e-42f9-aab4-cffab940d2dd";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;
type AgentRunStatus = (typeof agentRuns.$inferSelect)["status"];

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

export function presentationTemplateAnalysisRunId(templateId: string): string {
  return uuidv5(templateId, ANALYSIS_RUN_ID_NAMESPACE);
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

function presentationTemplateIdFromVars(vars: unknown): string | null {
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    return null;
  }
  const templateId = Reflect.get(vars, "PRESENTATION_TEMPLATE_ID");
  return typeof templateId === "string" ? templateId : null;
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
  if (args.runId !== presentationTemplateAnalysisRunId(args.templateId)) {
    return null;
  }
  const [run] = await db
    .select({
      vars: agentRuns.vars,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
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

export async function loadPresentationTemplateAnalysisRunStatus(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly templateId: string;
  },
): Promise<AgentRunStatus | null> {
  const [run] = await db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, presentationTemplateAnalysisRunId(args.templateId)),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.ownerUserId),
        eq(agentRuns.triggerSource, "template-import"),
      ),
    )
    .limit(1);
  return run?.status ?? null;
}

export async function loadPresentationTemplateImportRun(
  db: ReadonlyDb,
  args: { readonly runId: string; readonly templateId: string },
): Promise<{
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly template: PresentationTemplateRow | null;
} | null> {
  if (args.runId !== presentationTemplateAnalysisRunId(args.templateId)) {
    return null;
  }
  const [run] = await db
    .select({
      orgId: agentRuns.orgId,
      ownerUserId: agentRuns.userId,
      vars: agentRuns.vars,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
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
        ne(presentationTemplates.status, "pending"),
      ),
    )
    .orderBy(desc(presentationTemplates.createdAt));
}
