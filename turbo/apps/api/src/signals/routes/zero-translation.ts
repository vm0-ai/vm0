import { zeroTranslationContract } from "@okouai/api-contracts/contracts/zero-translation";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroTranslation$ } from "../services/zero-translation.service";

const translationBody$ = bodyResultOf(zeroTranslationContract.translate);

const translateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    throw new Error("Zero translation route requires Zero authentication");
  }
  const bodyResult = await get(translationBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(zeroTranslation$, { auth, body: bodyResult.data }, signal);
});

export const zeroTranslationRoutes: readonly RouteEntry[] = [
  {
    route: zeroTranslationContract.translate,
    handler: authRoute(
      {
        accept: ["zero"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "translation:write",
      },
      translateInner$,
    ),
  },
];
