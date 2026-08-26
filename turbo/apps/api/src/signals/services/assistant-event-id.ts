import { v5 as uuidv5 } from "uuid";

const ASSISTANT_EVENT_ID_NAMESPACE = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";
const RECOMMENDED_FOLLOWUPS_EVENT_ID_NAMESPACE =
  "45a94d31-ad63-42d4-8d7c-6597042c93cf";
const INTEGRATION_COMPLETION_FALLBACK_EVENT_ID_NAMESPACE =
  "d1cbb152-c744-432a-8cbe-ff7846ef11b7";
const RUN_TIME_BUDGET_EVENT_ID_NAMESPACE =
  "354e77a2-8a0a-48f3-9414-97a5ea08727f";
const TOOL_EVENT_ID_NAMESPACE = "cd50cb06-c328-4ff0-b6b5-a152b8970d3f";
const TOOL_USE_ID_NAMESPACE = "6915e503-2e60-4455-9674-93d28248e751";

export function assistantEventIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`${runId}:${runEventId}`, ASSISTANT_EVENT_ID_NAMESPACE);
}

/** Tool snapshots use a row namespace independent from transcript outputs. */
export function toolEventIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`${runId}:${runEventId}`, TOOL_EVENT_ID_NAMESPACE);
}

/** Provider IDs are derivation seeds only; the returned correlation is opaque. */
export function toolUseIdForProviderOperation(
  runId: string,
  provider: "claude" | "codex" | "pi",
  providerOperationId: string,
): string {
  return uuidv5(
    `${provider}:${runId}:${providerOperationId}`,
    TOOL_USE_ID_NAMESPACE,
  );
}

/** Completed-only operations correlate to their canonical event, not item IDs. */
export function toolUseIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`event:${runId}:${runEventId}`, TOOL_USE_ID_NAMESPACE);
}

export function followupsEventIdForRun(runId: string): string {
  return uuidv5(runId, RECOMMENDED_FOLLOWUPS_EVENT_ID_NAMESPACE);
}

export function integrationCompletionFallbackEventIdForRun(
  runId: string,
): string {
  return uuidv5(runId, INTEGRATION_COMPLETION_FALLBACK_EVENT_ID_NAMESPACE);
}

export function runTimeBudgetEventIdForRun(runId: string): string {
  return uuidv5(runId, RUN_TIME_BUDGET_EVENT_ID_NAMESPACE);
}
