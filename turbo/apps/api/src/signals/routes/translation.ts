import { translationContract } from "@okouai/api-contracts/contracts/translation";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { translation$ } from "../services/translation.service";

const translationBody$ = bodyResultOf(translationContract.translate);

const translateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Translation route requires run authentication");
  }
  const bodyResult = await get(translationBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(translation$, { auth, body: bodyResult.data }, signal);
});

/**
 * Rollout fallback. Surface: pre-deployment commit-addressed CLI -> new API.
 * Contexts can hold the old CLI package for the two-hour queue lifetime plus
 * maximum claimed execution and bounded finalization. Remove under #29356 once
 * no queued or active pre-deployment context or supported external caller can
 * invoke this route.
 */
export const translationRoutes: readonly RouteEntry[] = [
  {
    route: translationContract.translate,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "translation:write",
      },
      translateInner$,
    ),
  },
];
