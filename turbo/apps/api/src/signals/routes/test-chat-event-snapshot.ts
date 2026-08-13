import { testChatEventSnapshotContract } from "@vm0/api-contracts/contracts/test-chat-event-snapshot";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { snapshotChatEvents$ } from "../services/cron-snapshot-chat-events.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const snapshotBody$ = bodyResultOf(testChatEventSnapshotContract.snapshot);

const snapshotChatEventFixturesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(snapshotBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      snapshotChatEvents$,
      {
        kind: "fixtures",
        chatThreadIds: bodyResult.data.chat_thread_ids,
        r2ObjectKeys: bodyResult.data.r2_object_keys,
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

export const testChatEventSnapshotRoutes: readonly RouteEntry[] = [
  {
    route: testChatEventSnapshotContract.snapshot,
    handler: snapshotChatEventFixturesRoute$,
  },
];
