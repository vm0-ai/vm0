import { command } from "ccstate";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { chatThreadMarkAgentReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { latestRunFinishEventSubquery } from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markAgentReadBody$ = bodyResultOf(
  chatThreadMarkAgentReadContract.markAgentRead,
);

const markAgentReadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(markAgentReadBody$);
    signal.throwIfAborted();

    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    const latestRunFinish = latestRunFinishEventSubquery(
      writeDb,
      chatThreads.id,
    );
    const unreadThreads = writeDb
      .select({
        threadId: chatThreads.id,
        latestRunFinishAt: latestRunFinish.createdAt,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .crossJoinLateral(latestRunFinish)
      .where(
        and(
          eq(chatThreads.userId, auth.userId),
          eq(agents.orgId, auth.orgId),
          eq(chatThreads.agentId, bodyResult.data.agentId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(latestRunFinish.createdAt, chatThreads.lastReadAt),
          ),
        ),
      )
      .as("unread_threads");
    const updatedRows = await writeDb
      .update(chatThreads)
      .set({ lastReadAt: unreadThreads.latestRunFinishAt })
      .from(unreadThreads)
      .where(
        and(
          eq(chatThreads.id, unreadThreads.threadId),
          eq(chatThreads.userId, auth.userId),
          eq(chatThreads.agentId, bodyResult.data.agentId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(unreadThreads.latestRunFinishAt, chatThreads.lastReadAt),
          ),
        ),
      )
      .returning({ threadId: chatThreads.id });
    signal.throwIfAborted();
    const updatedThreadIds = updatedRows.map((row) => {
      return row.threadId;
    });

    if (updatedThreadIds.length > 0) {
      await publishChatThreadReadCursorUpdatedSafely(
        { userId: auth.userId, orgId: auth.orgId },
        {
          agentId: bodyResult.data.agentId,
          threadIds: updatedThreadIds,
        },
      );
      signal.throwIfAborted();
    }

    return { status: 204 as const, body: undefined };
  },
);

export const chatThreadMarkAgentReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkAgentReadContract.markAgentRead,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      markAgentReadInner$,
    ),
  },
];
