import { testGoogleFormsWatchRenewalContract } from "@okouai/api-contracts/contracts/test-google-forms-watch-renewal";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { renewGoogleFormsWatchScope$ } from "../services/google-forms-automation-event.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testGoogleFormsWatchRenewalContract.renew);

const renewGoogleFormsWatchScopeRoute$ = command(
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
      renewGoogleFormsWatchScope$,
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
        failed: result.failed,
      },
    };
  },
);

export const testGoogleFormsWatchRenewalRoutes: readonly RouteEntry[] = [
  {
    route: testGoogleFormsWatchRenewalContract.renew,
    handler: renewGoogleFormsWatchScopeRoute$,
  },
];
