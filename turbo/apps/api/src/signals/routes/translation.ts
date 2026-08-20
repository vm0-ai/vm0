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
  if (auth.tokenType !== "zero") {
    throw new Error("Translation route requires run authentication");
  }
  const bodyResult = await get(translationBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(translation$, { auth, body: bodyResult.data }, signal);
});

export const translationRoutes: readonly RouteEntry[] = [
  {
    route: translationContract.translate,
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
