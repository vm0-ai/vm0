import { testGoogleMeetSubscriptionRenewalContract } from "@okouai/api-contracts/contracts/test-google-meet-subscription-renewal";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { renewGoogleMeetSubscriptionScope$ } from "../services/google-meet-automation-event.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testGoogleMeetSubscriptionRenewalContract.renew);

const renewGoogleMeetSubscriptionScopeRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(body$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      renewGoogleMeetSubscriptionScope$,
      {
        orgId: bodyResult.data.org_id,
        userId: bodyResult.data.user_id,
      },
      signal,
    );
    return {
      status: 200 as const,
      body: {
        success: true as const,
        renewed: result.renewed,
        repaired: result.repaired,
        failed: result.failed,
      },
    };
  },
);

export const testGoogleMeetSubscriptionRenewalRoutes: readonly RouteEntry[] = [
  {
    route: testGoogleMeetSubscriptionRenewalContract.renew,
    handler: renewGoogleMeetSubscriptionScopeRoute$,
  },
];
