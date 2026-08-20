import { socialContract } from "@okouai/api-contracts/contracts/social";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { socialTranscript$ } from "../services/social.service";

const socialTranscriptBody$ = bodyResultOf(socialContract.transcript);

const socialTranscriptInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialTranscriptBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      socialTranscript$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

export const socialRoutes: readonly RouteEntry[] = [
  {
    route: socialContract.transcript,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      socialTranscriptInner$,
    ),
  },
];
