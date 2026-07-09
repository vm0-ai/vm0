import { command } from "ccstate";
import { artifactsContract } from "@vm0/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { zeroArtifacts$ } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route-entry";

const listArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactsContract.list));

    const result = await set(
      zeroArtifacts$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        limit: query.limit,
        cursor: query.cursor,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        artifacts: result.artifacts,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
      },
    };
  },
);

export const zeroArtifactsRoutes: readonly RouteEntry[] = [
  {
    route: artifactsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      listArtifactsInner$,
    ),
  },
];
