import { command } from "ccstate";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { logger } from "../log.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-panes.ts";
import { warmLatestChatThreadMessages$ } from "./idb-cached-chat-thread-data-source.ts";

const L = logger("BackgroundChatThreadCache");
const CHAT_THREAD_RUN_FINISHED_TOPIC = "chatThreadRunFinished";

function threadIdFromRunFinishedPayload(payload: unknown): string | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("threadId" in payload)
  ) {
    return null;
  }

  const threadId = (payload as { readonly threadId: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}

const warmFinishedThread$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const threadId = threadIdFromRunFinishedPayload(payload);
    if (!threadId) {
      L.warn("runFinished:invalidPayload", { payload });
      return false;
    }

    const leftThreadId = get(currentLeftThread$)?.threadId;
    const rightThreadId = get(currentRightThread$)?.threadId;
    if (threadId === leftThreadId || threadId === rightThreadId) {
      L.debug("runFinished:threadOpen", { threadId });
      return false;
    }

    await set(warmLatestChatThreadMessages$, threadId, signal);
    signal.throwIfAborted();
    return false;
  },
);

export const subscribeBackgroundChatThreadRunFinished$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyPayloadLoop$,
      CHAT_THREAD_RUN_FINISHED_TOPIC,
      warmFinishedThread$,
      signal,
    );
  },
);
