import { command } from "ccstate";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { badRequestMessage, notFound } from "../../lib/error";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { updateChatThreadDraft$ } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route-entry";

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

  if (bodyResult.data.draftFeedbackPayload) {
    if (!auth.orgId) {
      return badRequestMessage("Feedback message cards are not enabled");
    }
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      set(writeDb$),
      auth.orgId,
      auth.userId,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.FeedbackMessageCards,
        featureSwitchContext,
      )
    ) {
      return badRequestMessage("Feedback message cards are not enabled");
    }
  }

  const result = await set(
    updateChatThreadDraft$,
    {
      threadId: params.id,
      userId: auth.userId,
      draftContent: bodyResult.data.draftContent ?? null,
      draftFeedbackPayload: bodyResult.data.draftFeedbackPayload,
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
