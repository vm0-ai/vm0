import { command } from "ccstate";
import { z } from "zod";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { deleteChatThread$ } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route";

const chatThreadIdSchema = z.string().uuid();

function isValidChatThreadId(id: string): boolean {
  return chatThreadIdSchema.safeParse(id).success;
}

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.delete));

  if (!isValidChatThreadId(params.id)) {
    return chatThreadNotFound();
  }

  const result = await set(
    deleteChatThread$,
    { threadId: params.id, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  if (!result.deleted) {
    return chatThreadNotFound();
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
