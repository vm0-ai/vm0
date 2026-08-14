import { agentRuns } from "@okouai/db/schema/agent-run";
import { zeroRuns } from "@okouai/db/schema/zero-run";
import { and, inArray, or, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

export type RunMetadataValues = Pick<
  typeof zeroRuns.$inferSelect,
  | "triggerSource"
  | "autonomyBudget"
  | "workflowAutomationId"
  | "goalId"
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "selectedModel"
  | "codexServiceTier"
  | "selectedVideoModel"
  | "chatThreadId"
  | "apiStartedAt"
  | "firstAssistantEventAcknowledgedAt"
  | "summary"
  | "triggerBrief"
>;

export type RunMetadataInput = Readonly<
  Pick<RunMetadataValues, "triggerSource"> &
    Partial<Omit<RunMetadataValues, "triggerSource">>
>;

type RunMetadataPatch = {
  [Key in keyof RunMetadataValues]: Readonly<
    Pick<RunMetadataValues, Key> & Partial<RunMetadataValues>
  >;
}[keyof RunMetadataValues];

interface RunMetadataWriteArgs {
  readonly patch: RunMetadataPatch;
  readonly where: SQL;
}

export interface RunMetadataSourceRow {
  readonly id: string;
  readonly apiStartedAt: Date | null;
}

export function normalizeRunMetadata(
  input: RunMetadataInput,
): RunMetadataValues {
  return {
    triggerSource: input.triggerSource,
    autonomyBudget: input.autonomyBudget ?? 10,
    workflowAutomationId: input.workflowAutomationId ?? null,
    goalId: input.goalId ?? null,
    modelProvider: input.modelProvider ?? null,
    modelProviderId: input.modelProviderId ?? null,
    modelProviderCredentialScope: input.modelProviderCredentialScope ?? null,
    selectedModel: input.selectedModel ?? null,
    codexServiceTier: input.codexServiceTier ?? null,
    selectedVideoModel: input.selectedVideoModel ?? null,
    chatThreadId: input.chatThreadId ?? null,
    apiStartedAt: input.apiStartedAt ?? null,
    firstAssistantEventAcknowledgedAt:
      input.firstAssistantEventAcknowledgedAt ?? null,
    summary: input.summary ?? null,
    triggerBrief: input.triggerBrief ?? null,
  };
}

function targetMetadataDiffPredicate(patch: RunMetadataPatch): SQL {
  const predicates: SQL[] = [];

  if (patch.triggerSource !== undefined) {
    predicates.push(
      sql`${agentRuns.triggerSource} IS DISTINCT FROM ${patch.triggerSource}`,
    );
  }
  if (patch.autonomyBudget !== undefined) {
    predicates.push(
      sql`${agentRuns.autonomyBudget} IS DISTINCT FROM ${patch.autonomyBudget}`,
    );
  }
  if (patch.workflowAutomationId !== undefined) {
    predicates.push(
      sql`${agentRuns.workflowAutomationId} IS DISTINCT FROM ${patch.workflowAutomationId}`,
    );
  }
  if (patch.goalId !== undefined) {
    predicates.push(sql`${agentRuns.goalId} IS DISTINCT FROM ${patch.goalId}`);
  }
  if (patch.modelProvider !== undefined) {
    predicates.push(
      sql`${agentRuns.modelProvider} IS DISTINCT FROM ${patch.modelProvider}`,
    );
  }
  if (patch.modelProviderId !== undefined) {
    predicates.push(
      sql`${agentRuns.modelProviderId} IS DISTINCT FROM ${patch.modelProviderId}`,
    );
  }
  if (patch.modelProviderCredentialScope !== undefined) {
    predicates.push(
      sql`${agentRuns.modelProviderCredentialScope} IS DISTINCT FROM ${patch.modelProviderCredentialScope}`,
    );
  }
  if (patch.selectedModel !== undefined) {
    predicates.push(
      sql`${agentRuns.selectedModel} IS DISTINCT FROM ${patch.selectedModel}`,
    );
  }
  if (patch.codexServiceTier !== undefined) {
    predicates.push(
      sql`${agentRuns.codexServiceTier} IS DISTINCT FROM ${patch.codexServiceTier}`,
    );
  }
  if (patch.selectedVideoModel !== undefined) {
    predicates.push(
      sql`${agentRuns.selectedVideoModel} IS DISTINCT FROM ${patch.selectedVideoModel}`,
    );
  }
  if (patch.chatThreadId !== undefined) {
    predicates.push(
      sql`${agentRuns.chatThreadId} IS DISTINCT FROM ${patch.chatThreadId}`,
    );
  }
  if (patch.apiStartedAt !== undefined) {
    predicates.push(
      sql`${agentRuns.apiStartedAt} IS DISTINCT FROM ${patch.apiStartedAt}`,
    );
  }
  if (patch.firstAssistantEventAcknowledgedAt !== undefined) {
    predicates.push(
      sql`${agentRuns.firstAssistantEventAcknowledgedAt} IS DISTINCT FROM ${patch.firstAssistantEventAcknowledgedAt}`,
    );
  }
  if (patch.summary !== undefined) {
    predicates.push(
      sql`${agentRuns.summary} IS DISTINCT FROM ${patch.summary}`,
    );
  }
  if (patch.triggerBrief !== undefined) {
    predicates.push(
      sql`${agentRuns.triggerBrief} IS DISTINCT FROM ${patch.triggerBrief}`,
    );
  }

  const predicate = or(...predicates);
  if (!predicate) {
    throw new Error("Run metadata patch must contain at least one field");
  }
  return predicate;
}

export async function writeRunMetadataInTransaction(
  tx: Tx,
  args: RunMetadataWriteArgs,
): Promise<readonly RunMetadataSourceRow[]> {
  const sourceRows = await tx
    .update(zeroRuns)
    .set(args.patch)
    .where(args.where)
    .returning({ id: zeroRuns.id, apiStartedAt: zeroRuns.apiStartedAt });

  if (sourceRows.length === 0) {
    return sourceRows;
  }

  await tx
    .update(agentRuns)
    .set(args.patch)
    .where(
      and(
        inArray(
          agentRuns.id,
          sourceRows.map((row) => {
            return row.id;
          }),
        ),
        targetMetadataDiffPredicate(args.patch),
      ),
    );

  return sourceRows;
}

export function writeRunMetadata(
  db: Db,
  args: RunMetadataWriteArgs,
): Promise<readonly RunMetadataSourceRow[]> {
  return db.transaction(async (tx) => {
    return await writeRunMetadataInTransaction(tx, args);
  });
}
