import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import {
  sendNewThreadMessage$,
  type SendNewThreadMessagePending,
  type SendNewThreadMessageRequest,
} from "./chat-message.ts";

const internalOptimisticThreadSend$ = state<SendNewThreadMessagePending | null>(
  null,
);

export const optimisticThreadSend$ = computed((get) => {
  return get(internalOptimisticThreadSend$);
});

const setOptimisticThreadSend$ = command(
  ({ set }, pending: SendNewThreadMessagePending) => {
    set(internalOptimisticThreadSend$, pending);
  },
);

const clearMatchingOptimisticThreadSend$ = command(
  ({ set }, pending: SendNewThreadMessagePending) => {
    set(internalOptimisticThreadSend$, (current) => {
      return current === pending ? null : current;
    });
  },
);

export const sendNewThreadOptimistically$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ) => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return;
    }
    signal.throwIfAborted();

    signal.addEventListener("abort", () => {
      set(clearMatchingOptimisticThreadSend$, result);
    });
    set(setOptimisticThreadSend$, result);

    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: result.threadId },
    });

    await result.sendResult;
    signal.throwIfAborted();

    set(clearMatchingOptimisticThreadSend$, result);
  },
);
