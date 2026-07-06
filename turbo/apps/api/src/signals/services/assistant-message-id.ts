import { v5 as uuidv5 } from "uuid";

const ASSISTANT_MESSAGE_ID_NAMESPACE = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";
const RECOMMENDED_FOLLOWUPS_MESSAGE_ID_NAMESPACE =
  "45a94d31-ad63-42d4-8d7c-6597042c93cf";

export function assistantMessageIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`${runId}:${runEventId}`, ASSISTANT_MESSAGE_ID_NAMESPACE);
}

export function recommendedFollowupsMessageIdForRun(runId: string): string {
  return uuidv5(runId, RECOMMENDED_FOLLOWUPS_MESSAGE_ID_NAMESPACE);
}
