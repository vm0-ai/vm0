import { command } from "ccstate";
import { zeroUsageRecordContract } from "@vm0/api-contracts/contracts/zero-usage-record";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { rawQuery$ } from "../context/hono";
import { queryOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { zeroUsageRecord$ } from "../services/zero-usage-record.service";
import type { RouteEntry } from "../route";
import { isValidTimeZone } from "../utils";

function teamUsageRecordsUnavailable() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    },
  };
}

function creditUsageRecordsDisabled() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Credit usage records are not enabled",
        code: "FORBIDDEN",
      },
    },
  };
}

function usesScopedUsageRecordQuery(
  rawQuery: Record<string, string | string[]>,
): boolean {
  return (
    rawQuery.scope !== undefined ||
    rawQuery.range !== undefined ||
    rawQuery.tz !== undefined
  );
}

const getUsageRecordInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(zeroUsageRecordContract.get));
    const rawQuery = get(rawQuery$);

    if (!isValidTimeZone(query.tz)) {
      return badRequestMessage(`Invalid timezone: ${query.tz}`);
    }

    if (query.scope === "team") {
      return teamUsageRecordsUnavailable();
    }

    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const creditUsageRecordsEnabled = isFeatureEnabled(
      FeatureSwitchKey.CreditUsageRecords,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      },
    );
    if (usesScopedUsageRecordQuery(rawQuery) && !creditUsageRecordsEnabled) {
      return creditUsageRecordsDisabled();
    }

    const body = await set(
      zeroUsageRecord$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        scope: query.scope,
        range: creditUsageRecordsEnabled ? query.range : "all",
        tz: query.tz,
        page: query.page,
        pageSize: query.pageSize,
        source: query.source,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body };
  },
);

export const zeroUsageRecordRoutes: readonly RouteEntry[] = [
  {
    route: zeroUsageRecordContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageRecordInner$,
    ),
  },
];
