import { command } from "ccstate";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { chatThreadMarkAgentReadContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { excludeGoalMarkerCondition } from "../services/zero-chat-goal-marker.service";
import { visibleChatMessageCondition } from "../services/zero-chat-message-shared.service";
import type { RouteEntry } from "../route-entry";

const markAgentReadBody$ = bodyResultOf(
  chatThreadMarkAgentReadContract.markAgentRead,
);

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

function lastVisibleMessageSubquery(db: Pick<Db, "select">) {
  return db
    .select({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreads.id),
        visibleChatMessageCondition(),
        excludeGoalMarkerCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1)
    .as("last_message");
}

const markAgentReadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(markAgentReadBody$);
    signal.throwIfAborted();

    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    if (
      !isFeatureEnabled(FeatureSwitchKey.AgentUnreadIndicators, {
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return forbidden("Agent unread indicators are not enabled");
    }

    const writeDb = set(writeDb$);
    const updatedThreadIds = await writeDb.transaction(async (tx) => {
      const lastMessage = lastVisibleMessageSubquery(tx);
      const unreadRows = await tx
        .select({
          threadId: chatThreads.id,
          latestMessageId: lastMessage.id,
        })
        .from(chatThreads)
        .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
        .leftJoinLateral(lastMessage, sql`true`)
        .where(
          and(
            eq(chatThreads.userId, auth.userId),
            eq(zeroAgents.orgId, auth.orgId),
            eq(chatThreads.agentComposeId, bodyResult.data.agentId),
            isNotNull(lastMessage.id),
            or(
              isNull(chatThreads.lastReadMessageId),
              sql`${chatThreads.lastReadMessageId} <> ${lastMessage.id}`,
            )!,
          ),
        );

      for (const row of unreadRows) {
        if (row.latestMessageId === null) {
          continue;
        }
        await tx
          .update(chatThreads)
          .set({ lastReadMessageId: row.latestMessageId })
          .where(
            and(
              eq(chatThreads.id, row.threadId),
              eq(chatThreads.userId, auth.userId),
            ),
          );
      }

      return unreadRows.map((row) => {
        return row.threadId;
      });
    });
    signal.throwIfAborted();

    if (updatedThreadIds.length > 0) {
      await publishUserSignal([auth.userId], "chatThreadReadCursorUpdated", {
        agentId: bodyResult.data.agentId,
        threadIds: updatedThreadIds,
      });
      signal.throwIfAborted();
    }

    return { status: 204 as const, body: undefined };
  },
);

export const zeroChatThreadMarkAgentReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkAgentReadContract.markAgentRead,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      markAgentReadInner$,
    ),
  },
];
