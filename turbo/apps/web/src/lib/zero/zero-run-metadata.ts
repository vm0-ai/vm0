import { zeroRuns } from "@vm0/db/schema/zero-run";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import type { Database } from "../../types/global";

export interface ZeroRunMetadataValues {
  triggerSource: TriggerSource;
  scheduleId?: string;
  triggerAgentId?: string;
  chatThreadId?: string;
  modelProvider?: string;
  selectedModel?: string;
}

export async function persistZeroRunMetadata(
  db: Database,
  runId: string,
  metadata: ZeroRunMetadataValues,
): Promise<void> {
  await db.insert(zeroRuns).values({
    id: runId,
    triggerSource: metadata.triggerSource,
    scheduleId: metadata.scheduleId ?? null,
    triggerAgentId: metadata.triggerAgentId ?? null,
    chatThreadId: metadata.chatThreadId ?? null,
    modelProvider: metadata.modelProvider ?? null,
    selectedModel: metadata.selectedModel ?? null,
  });
}
