import { command, computed } from "ccstate";
import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroMemoryDetail } from "../services/zero-memory-detail.service";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { listMemorySources } from "../services/memory-substrate.service";
import {
  getSlackMemoryStatus,
  restartSlackMemoryBackfill,
  stopSlackMemoryBackfill,
} from "../services/slack-memory-backfill.service";

const memoryAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const memorySourceDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Relationship memory is not enabled for this organization.",
      code: "FORBIDDEN",
    }),
  }),
});

async function isMemorySourceEnabled(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.RelationshipMemory, context);
}

const getMemoryInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const detail = await get(zeroMemoryDetail(auth.orgId, auth.userId));
  return {
    status: 200 as const,
    body: detail,
  };
});

const memorySourcesQuery$ = queryOf(zeroMemoryContract.sources);
const slackBackfillBody$ = bodyResultOf(zeroMemoryContract.slackBackfill);

const memorySourcesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memorySourcesQuery$);
  const result = await listMemorySources(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    provider: query.provider,
    page: query.page,
    limit: query.limit,
  });

  return {
    status: 200 as const,
    body: result,
  };
});

const slackStatusInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const result = await getSlackMemoryStatus(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  return { status: 200 as const, body: result };
});

const slackBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(slackBackfillBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await restartSlackMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      options: bodyResult.data,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: result.message,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    return { status: 200 as const, body: result.status };
  },
);

const slackStopBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }
    signal.throwIfAborted();

    const result = await stopSlackMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: result.message,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    return { status: 200 as const, body: result.status };
  },
);

export const zeroMemoryRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemoryContract.get,
    handler: authRoute(memoryAuthOptions, getMemoryInner$),
  },
  {
    route: zeroMemoryContract.sources,
    handler: authRoute(memoryAuthOptions, memorySourcesInner$),
  },
  {
    route: zeroMemoryContract.slackStatus,
    handler: authRoute(memoryAuthOptions, slackStatusInner$),
  },
  {
    route: zeroMemoryContract.slackBackfill,
    handler: authRoute(memoryAuthOptions, slackBackfillInner$),
  },
  {
    route: zeroMemoryContract.slackStopBackfill,
    handler: authRoute(memoryAuthOptions, slackStopBackfillInner$),
  },
];
