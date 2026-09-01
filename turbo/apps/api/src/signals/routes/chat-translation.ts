import { chatTranslationContract } from "@okouai/api-contracts/contracts/chat-translation";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { translateSelectedChatText$ } from "../services/chat-translation.service";

const chatTranslationBody$ = bodyResultOf(chatTranslationContract.translate);

const chatTranslationDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Chat translation is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

const chatTranslationEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ChatTranslation, context);
});

const translateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(chatTranslationEnabled$))) {
    return chatTranslationDisabled;
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(chatTranslationBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    translateSelectedChatText$,
    { orgId: auth.orgId, userId: auth.userId, body: bodyResult.data },
    signal,
  );
});

export const chatTranslationRoutes: readonly RouteEntry[] = [
  {
    route: chatTranslationContract.translate,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      translateInner$,
    ),
  },
];
