import { command } from "ccstate";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { testChatThreadStateContract } from "@vm0/api-contracts/contracts/test-chat-thread-state";
import { and, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const setLegacyModelStateBody$ = bodyResultOf(
  testChatThreadStateContract.setLegacyModelState,
);

const setLegacyModelState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const body = await get(setLegacyModelStateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const [thread] = await set(writeDb$)
      .update(chatThreads)
      .set({
        modelProviderId: body.data.modelProviderId,
        modelProviderType: body.data.modelProviderType,
        modelProviderCredentialScope: body.data.modelProviderCredentialScope,
        selectedModel: body.data.selectedModel,
        codexServiceTier: body.data.codexServiceTier,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(chatThreads.id, body.data.threadId),
          eq(chatThreads.userId, body.data.userId),
        ),
      )
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    if (!thread) {
      return {
        status: 404 as const,
        body: { error: "Chat thread not found" },
      };
    }
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testChatThreadStateRoutes: readonly RouteEntry[] = [
  {
    route: testChatThreadStateContract.setLegacyModelState,
    handler: setLegacyModelState$,
  },
];
