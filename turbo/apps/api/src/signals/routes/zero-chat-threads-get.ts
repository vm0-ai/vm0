import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadMetadataContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { notFound } from "../../lib/error";
import { chatThreadServiceTierFromCodex } from "../services/zero-chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const getInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMetadataContract.get));
  signal.throwIfAborted();

  const db = get(db$);
  const [thread] = await db
    .select({
      id: chatThreads.id,
      agentId: chatThreads.agentComposeId,
      title: chatThreads.title,
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
    })
    .from(chatThreads)
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!thread) {
    return notFound("Chat thread not found");
  }

  return {
    status: 200 as const,
    body: {
      id: thread.id,
      agentId: thread.agentId,
      title: thread.title,
      selectedModel: thread.selectedModel,
      serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
    },
  };
});

export const zeroChatThreadGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMetadataContract.get,
    handler: authRoute({ requiredCapability: "chat-thread:read" }, getInner$),
  },
];
