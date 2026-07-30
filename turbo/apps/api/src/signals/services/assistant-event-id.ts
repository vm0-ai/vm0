import { v5 as uuidv5 } from "uuid";

const ASSISTANT_EVENT_ID_NAMESPACE = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";
const RECOMMENDED_FOLLOWUPS_EVENT_ID_NAMESPACE =
  "45a94d31-ad63-42d4-8d7c-6597042c93cf";
const INTEGRATION_COMPLETION_FALLBACK_EVENT_ID_NAMESPACE =
  "d1cbb152-c744-432a-8cbe-ff7846ef11b7";

export function assistantEventIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`${runId}:${runEventId}`, ASSISTANT_EVENT_ID_NAMESPACE);
}

export function recommendedFollowupsEventIdForRun(runId: string): string {
  return uuidv5(runId, RECOMMENDED_FOLLOWUPS_EVENT_ID_NAMESPACE);
}

export function integrationCompletionFallbackEventIdForRun(
  runId: string,
): string {
  return uuidv5(runId, INTEGRATION_COMPLETION_FALLBACK_EVENT_ID_NAMESPACE);
}
