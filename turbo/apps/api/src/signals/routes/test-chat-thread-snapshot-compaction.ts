import { testChatThreadSnapshotCompactionContract } from "@okouai/api-contracts/contracts/test-chat-thread-snapshot-compaction";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { compactChatThreadSnapshots$ } from "../services/cron-compact-chat-thread-snapshots.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const compactBody$ = bodyResultOf(
  testChatThreadSnapshotCompactionContract.compact,
);

const compactChatThreadSnapshotFixturesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(compactBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      compactChatThreadSnapshots$,
      {
        kind: "fixtures",
        scopes: bodyResult.data.scopes.map((scope) => {
          return { userId: scope.user_id, orgId: scope.org_id };
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const testChatThreadSnapshotCompactionRoutes: readonly RouteEntry[] = [
  {
    route: testChatThreadSnapshotCompactionContract.compact,
    handler: compactChatThreadSnapshotFixturesRoute$,
  },
];
