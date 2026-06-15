import { command } from "ccstate";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { deleteChatThread$ } from "../services/zero-chat-thread.service";
import { dispatchCancelSideEffects$ } from "../services/zero-run-cancel.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route";

const L = logger("ChatThreadDelete");

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.delete));

  const result = await set(
    deleteChatThread$,
    { threadId: params.id, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  if (!result.deleted) {
    return chatThreadNotFound();
  }

  // Dispatch post-cancel side effects (runner halt, queue drain, credit
  // reconciliation) for every run we stopped while tearing down the thread.
  for (const cancelled of result.cancelledRuns) {
    waitUntil(
      tapError(set(dispatchCancelSideEffects$, cancelled, signal), (error) => {
        L.error("dispatchCancelSideEffects failed", {
          runId: cancelled.runId,
          error,
        });
      }),
    );
  }

  await publishThreadListChanged(auth.userId);
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const zeroChatThreadDeleteRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadByIdContract.delete,
    handler: authRoute({}, deleteInner$),
  },
];
