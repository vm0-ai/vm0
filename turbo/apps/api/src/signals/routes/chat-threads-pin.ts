import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadPinContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
import type { RouteEntry } from "../route-entry";

const pinInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadPinContract.pin));
  const query = get(queryOf(chatThreadPinContract.pin));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  const updated = await writeDb.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ pinnedAt: nowDate() })
      .where(
        and(
          eq(chatThreads.id, params.id),
          eq(chatThreads.userId, auth.userId),
          chatThreadOrganizationCondition(tx, auth.orgId),
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
      kind: "pinned",
      userId: auth.userId,
      orgId: auth.orgId,
      chatThreadId: thread.id,
      agentId: thread.agentId,
      eventId: query?.eventId,
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

export const chatThreadPinRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadPinContract.pin,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      pinInner$,
    ),
  },
];
