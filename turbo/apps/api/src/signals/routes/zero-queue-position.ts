import { computed } from "ccstate";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";

import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { queuePosition } from "../services/queue-position.service";

const query$ = queryOf(zeroQueuePositionContract.getPosition);

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

export function zeroQueuePositionRoutes(
  source: ShadowCompareSource = "web",
): readonly RouteEntry[] {
  return [
    {
      route: zeroQueuePositionContract.getPosition,
      handler: shadowCompareRoute({
        routeName: "zero.queue-position.get",
        handler: authRoute({}, getQueuePositionInner$),
        source,
      }),
    },
  ];
}
