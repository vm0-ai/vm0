import { command } from "ccstate";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import { updateChatThreadDraft$ } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route";

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

const patchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.patch));

  const bodyResult = await get(bodyResultOf(chatThreadByIdContract.patch));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateChatThreadDraft$,
    {
      threadId: params.id,
      userId: auth.userId,
      draftContent: bodyResult.data.draftContent ?? null,
      draftAttachments: bodyResult.data.draftAttachments ?? null,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result.updated) {
    return chatThreadNotFound();
  }

  return { status: 204 as const, body: undefined };
});

export const zeroChatThreadPatchRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadByIdContract.patch,
    handler: authRoute({}, patchInner$),
  },
];
