import { computed } from "ccstate";
import { chatThreadDraftContract } from "@vm0/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  legacyFeedbackLocationAppClient$,
  projectLegacyUserMessageInputDocument,
} from "../services/chat-feedback-location-compatibility.service";
import { zeroChatThreadDraft } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route-entry";

const getThreadDraftInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadDraftContract.get));
  const draft = await get(
    zeroChatThreadDraft({ threadId: params.id, userId: auth.userId }),
  );
  if (!draft) {
    return notFound("Chat thread not found");
  }

  if (
    get(legacyFeedbackLocationAppClient$) &&
    draft.draftUserMessage !== null
  ) {
    return {
      status: 200 as const,
      body: {
        ...draft,
        draftUserMessage: projectLegacyUserMessageInputDocument(
          draft.draftUserMessage,
        ),
      },
    };
  }

  return { status: 200 as const, body: draft };
});

export const zeroChatThreadDraftGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadDraftContract.get,
    handler: authRoute({}, getThreadDraftInner$),
  },
];
