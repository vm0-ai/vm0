import { v5 as uuidv5 } from "uuid";

const ASSISTANT_MESSAGE_ID_NAMESPACE = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";

export function assistantMessageIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`${runId}:${runEventId}`, ASSISTANT_MESSAGE_ID_NAMESPACE);
}
