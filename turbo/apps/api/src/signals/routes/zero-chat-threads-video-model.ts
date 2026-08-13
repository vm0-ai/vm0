import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadVideoModelContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { appendChatThreadEvent } from "../services/zero-chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const videoModelBody$ = bodyResultOf(chatThreadVideoModelContract.update);

const updateVideoModelInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadVideoModelContract.update));
    const body = await get(videoModelBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const selectedVideoModel = body.data.model;
    const updated = await writeDb.transaction(async (tx) => {
      const updatedAt = nowDate();
      const [thread] = await tx
        .update(chatThreads)
        .set({ selectedVideoModel, updatedAt })
        .where(
          and(
            eq(chatThreads.id, params.id),
            eq(chatThreads.userId, auth.userId),
          ),
        )
        .returning({
          id: chatThreads.id,
          agentComposeId: chatThreads.agentComposeId,
        });
      if (!thread) {
        return false;
      }
      await appendChatThreadEvent(tx, {
        kind: "video_model_updated",
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: thread.id,
        agentComposeId: thread.agentComposeId,
        eventId: body.data.eventId,
        selectedVideoModel,
        createdAt: updatedAt,
      });
      return true;
    });
    signal.throwIfAborted();

    if (!updated) {
      return notFound("Chat thread not found");
    }

    await publishThreadListChanged(auth.userId);
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroChatThreadVideoModelRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadVideoModelContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      updateVideoModelInner$,
    ),
  },
];
