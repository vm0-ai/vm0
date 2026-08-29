import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const renameBody$ = bodyResultOf(chatThreadRenameContract.rename);

const renameInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadRenameContract.rename));
  const body = await get(renameBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);
  const updatedAt = nowDate();

  const updated = await writeDb.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ title: body.data.title, renamedAt: updatedAt, updatedAt })
      .where(
        and(
          eq(chatThreads.id, params.id),
          eq(chatThreads.userId, auth.userId),
          isNotNull(chatThreads.agentId),
        ),
      )
      .returning({
        id: chatThreads.id,
        agentId: chatThreads.agentId,
      });
    if (!thread?.agentId) {
      return false;
    }
    await appendChatThreadEvent(tx, {
      kind: "renamed",
      userId: auth.userId,
      orgId: auth.orgId,
      chatThreadId: thread.id,
      agentId: thread.agentId,
      eventId: body.data.eventId,
      title: body.data.title,
    });
    return true;
  });
  signal.throwIfAborted();

  if (!updated) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const chatThreadRenameRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadRenameContract.rename,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      renameInner$,
    ),
  },
];
