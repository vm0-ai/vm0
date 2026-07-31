import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
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

    let orgId: string;
    if ("org_id" in bodyResult.data) {
      orgId = bodyResult.data.org_id;
    } else {
      const [run] = await get(db$)
        .select({ orgId: agentRuns.orgId })
        .from(agentRuns)
        .where(eq(agentRuns.id, bodyResult.data.run_id))
        .limit(1);
      signal.throwIfAborted();
      if (!run) {
        return testEndpointNotFoundResponse();
      }
      orgId = run.orgId;
    }

    await set(processOrgUsageEvents$, orgId, signal);
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
