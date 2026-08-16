import { computed } from "ccstate";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import { chatThreadDraft } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

const getThreadDraftInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadDraftContract.get));
  const draft = await get(
    chatThreadDraft({ threadId: params.id, userId: auth.userId }),
  );
  if (!draft) {
    return notFound("Chat thread not found");
  }

  return { status: 200 as const, body: draft };
});

export const zeroChatThreadDraftGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadDraftContract.get,
    handler: authRoute({}, getThreadDraftInner$),
  },
];
