import { usageContract } from "@vm0/api-contracts/contracts/usage";
import { command } from "ccstate";

import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { usageSummary$ } from "../services/usage.service";

const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

function parseDateParam(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const getUsageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(usageContract.get));
  const now = nowDate();

  const endDate = query.end_date ? parseDateParam(query.end_date) : now;
  if (!endDate) {
    return badRequestMessage("Invalid end_date format. Use ISO 8601 format.");
  }

  const startDate = query.start_date
    ? parseDateParam(query.start_date)
    : new Date(endDate.getTime() - DEFAULT_RANGE_MS);
  if (!startDate) {
    return badRequestMessage("Invalid start_date format. Use ISO 8601 format.");
  }

  if (startDate >= endDate) {
    return badRequestMessage("start_date must be before end_date");
  }

  const rangeMs = endDate.getTime() - startDate.getTime();
  if (rangeMs > MAX_RANGE_MS) {
    return badRequestMessage(
      "Time range exceeds maximum of 30 days. Use --until to specify an end date.",
    );
  }

  const body = await set(
    usageSummary$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      now,
      startDate,
      endDate,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body };
});

export const usageRoutes: readonly RouteEntry[] = [
  {
    route: usageContract.get,
    handler: authRoute({ requireOrganization: true }, getUsageInner$),
  },
];
