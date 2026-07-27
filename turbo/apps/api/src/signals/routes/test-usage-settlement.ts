import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { processOrgUsageEvents$ } from "../services/zero-credit-usage.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const body$ = bodyResultOf(testUsageSettlementContract.process);

const processUsageSettlement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(body$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    await set(processOrgUsageEvents$, bodyResult.data.org_id, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testUsageSettlementRoutes: readonly RouteEntry[] = [
  {
    route: testUsageSettlementContract.process,
    handler: processUsageSettlement$,
  },
];
