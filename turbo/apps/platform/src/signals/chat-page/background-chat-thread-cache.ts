import { command } from "ccstate";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { logger } from "../log.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-panes.ts";
import { warmLatestChatThreadMessages$ } from "./chat-message-indexed-db.ts";

const L = logger("BackgroundChatThreadCache");
const CHAT_THREAD_FOLLOWUPS_FINISHED_TOPIC = "chatThreadFollowupsFinished";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function threadIdFromFollowupsFinishedPayload(payload: unknown): string | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("threadId" in payload)
  ) {
    return null;
  }

  const threadId = (payload as { readonly threadId: unknown }).threadId;
  return typeof threadId === "string" && uuidPattern.test(threadId)
    ? threadId
    : null;
}

const warmFollowupsFinishedThread$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const threadId = threadIdFromFollowupsFinishedPayload(payload);
    if (!threadId) {
      L.warn("followupsFinished:invalidPayload", { payload });
      return false;
    }

    const leftThreadId = get(currentLeftThread$)?.threadId;
    const rightThreadId = get(currentRightThread$)?.threadId;
    if (threadId === leftThreadId || threadId === rightThreadId) {
      L.debug("followupsFinished:threadOpen", { threadId });
      return false;
    }

    await set(warmLatestChatThreadMessages$, threadId, signal);
    signal.throwIfAborted();
    return false;
  },
);

export const subscribeBackgroundChatThreadFollowupsFinished$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyPayloadLoop$,
      {
        topic: CHAT_THREAD_FOLLOWUPS_FINISHED_TOPIC,
        loopCommand$: warmFollowupsFinishedThread$,
      },
      signal,
    );
  },
);
