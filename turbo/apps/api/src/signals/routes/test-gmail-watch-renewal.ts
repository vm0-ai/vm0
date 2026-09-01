import { testGmailWatchRenewalContract } from "@okouai/api-contracts/contracts/test-gmail-watch-renewal";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  processGmailWatchCleanupIntents,
  renewGmailWatchScope$,
} from "../services/gmail-automation-event.service";
import { writeDb$ } from "../external/db";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testGmailWatchRenewalContract.renew);
const cleanupBody$ = bodyResultOf(testGmailWatchRenewalContract.cleanup);

const cleanupGmailWatchRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(cleanupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await processGmailWatchCleanupIntents(
      {
        db: set(writeDb$),
        providerAccountId: bodyResult.data.provider_account_id,
      },
      signal,
    );
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

const renewGmailWatchScopeRoute$ = command(
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
      renewGmailWatchScope$,
      bodyResult.data.email_address,
      bodyResult.data.topic_name,
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

export const testGmailWatchRenewalRoutes: readonly RouteEntry[] = [
  {
    route: testGmailWatchRenewalContract.cleanup,
    handler: cleanupGmailWatchRoute$,
  },
  {
    route: testGmailWatchRenewalContract.renew,
    handler: renewGmailWatchScopeRoute$,
  },
];
