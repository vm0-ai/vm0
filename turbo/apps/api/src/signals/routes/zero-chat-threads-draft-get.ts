import { computed } from "ccstate";
import { chatThreadDraftContract } from "@vm0/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { notFound } from "../../lib/error";
import { zeroChatThreadDraft } from "../services/zero-chat-thread.service";
import {
  canonicalSlackWebVisibilityEnabled,
  isChatThreadVisibleInWeb,
} from "../services/canonical-slack-web-visibility.service";
import type { RouteEntry } from "../route-entry";

const getThreadDraftInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadDraftContract.get));
  const db = get(db$);
  const canonicalSlackVisible = await canonicalSlackWebVisibilityEnabled(db, {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  if (
    !(await isChatThreadVisibleInWeb(db, {
      threadId: params.id,
      userId: auth.userId,
      canonicalSlackVisible,
    }))
  ) {
    return notFound("Chat thread not found");
  }
  const draft = await get(
    zeroChatThreadDraft({ threadId: params.id, userId: auth.userId }),
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
