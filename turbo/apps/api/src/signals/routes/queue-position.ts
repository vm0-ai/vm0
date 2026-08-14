import { computed } from "ccstate";
import { queuePositionContract } from "@okouai/api-contracts/contracts/queue-position";

import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { queuePosition } from "../services/queue-position.service";

const query$ = queryOf(queuePositionContract.getPosition);

const getQueuePositionInner$ = computed(async (get): Promise<unknown> => {
  const query = get(query$);
  const auth = get(authContext$);
  const result = await get(
    queuePosition({
      runId: query.runId,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  if (!result) {
    return notFound("Run not found");
  }

  return {
    status: 200 as const,
    body: result,
  };
});

export const queuePositionRoutes: readonly RouteEntry[] = [
  {
    route: queuePositionContract.getPosition,
    handler: authRoute({}, getQueuePositionInner$),
  },
];
