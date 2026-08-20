import { agentRuns } from "@okouai/db/schema/agent-run";
import type { SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

type StoredRunMetadataValues = Pick<
  typeof agentRuns.$inferSelect,
  | "triggerSource"
  | "autonomyBudget"
  | "workflowAutomationId"
  | "goalId"
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "selectedModel"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "vm0ModelKeyId"
  | "vm0ModelKeyRevision"
  | "vm0CredentialHealthGeneration"
  | "vm0CandidateHealthGeneration"
  | "vm0CredentialProbe"
  | "vm0CandidateProbe"
  | "vm0ProbeLeaseId"
  | "codexServiceTier"
  | "selectedVideoModel"
  | "selectedImageModel"
  | "chatThreadId"
  | "apiStartedAt"
  | "firstAssistantEventAcknowledgedAt"
  | "summary"
  | "triggerBrief"
>;

export type RunMetadataValues = Readonly<
  Omit<StoredRunMetadataValues, "triggerSource" | "autonomyBudget"> & {
    readonly triggerSource: NonNullable<
      StoredRunMetadataValues["triggerSource"]
    >;
    readonly autonomyBudget: NonNullable<
      StoredRunMetadataValues["autonomyBudget"]
    >;
  }
>;

type RunMetadataInput = Readonly<
  Pick<RunMetadataValues, "triggerSource"> &
    Partial<Omit<RunMetadataValues, "triggerSource">>
>;

type Vm0RunMetadataValues = Pick<
  RunMetadataValues,
  | "vm0ModelKeyId"
  | "vm0ModelKeyRevision"
  | "vm0CredentialHealthGeneration"
  | "vm0CandidateHealthGeneration"
  | "vm0CredentialProbe"
  | "vm0CandidateProbe"
  | "vm0ProbeLeaseId"
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

interface RunMetadataRow {
  readonly id: string;
  readonly apiStartedAt: Date | null;
}

function normalizeVm0RunMetadata(
  input: RunMetadataInput,
): Vm0RunMetadataValues {
  return {
    vm0ModelKeyId: input.vm0ModelKeyId ?? null,
    vm0ModelKeyRevision: input.vm0ModelKeyRevision ?? null,
    vm0CredentialHealthGeneration: input.vm0CredentialHealthGeneration ?? null,
    vm0CandidateHealthGeneration: input.vm0CandidateHealthGeneration ?? null,
    vm0CredentialProbe: input.vm0CredentialProbe ?? null,
    vm0CandidateProbe: input.vm0CandidateProbe ?? null,
    vm0ProbeLeaseId: input.vm0ProbeLeaseId ?? null,
  };
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
    modelRuntimeProvider: input.modelRuntimeProvider ?? null,
    modelRuntimeModel: input.modelRuntimeModel ?? null,
    ...normalizeVm0RunMetadata(input),
    codexServiceTier: input.codexServiceTier ?? null,
    selectedVideoModel: input.selectedVideoModel ?? null,
    selectedImageModel: input.selectedImageModel ?? null,
    chatThreadId: input.chatThreadId ?? null,
    apiStartedAt: input.apiStartedAt ?? null,
    firstAssistantEventAcknowledgedAt:
      input.firstAssistantEventAcknowledgedAt ?? null,
    summary: input.summary ?? null,
    triggerBrief: input.triggerBrief ?? null,
  };
}

export async function writeRunMetadataInTransaction(
  tx: Tx,
  args: RunMetadataWriteArgs,
): Promise<readonly RunMetadataRow[]> {
  return await tx
    .update(agentRuns)
    .set(args.patch)
    .where(args.where)
    .returning({ id: agentRuns.id, apiStartedAt: agentRuns.apiStartedAt });
}

export function writeRunMetadata(
  db: Db,
  args: RunMetadataWriteArgs,
): Promise<readonly RunMetadataRow[]> {
  return db.transaction(async (tx) => {
    return await writeRunMetadataInTransaction(tx, args);
  });
}
