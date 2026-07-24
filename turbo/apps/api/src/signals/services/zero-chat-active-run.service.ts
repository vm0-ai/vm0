import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  browserSessionInstances,
  browserSessions,
} from "@vm0/db/schema/browser-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "../external/db";

const ACTIVE_CHAT_RUN_STATUSES = ["queued", "pending", "running"] as const;
const BROWSER_ADMISSION_BLOCKING_STATUSES = [
  "creating",
  "active",
  "resuming",
  "stopping",
] as const;

async function activeChatRunExists(
  db: Pick<Db, "select">,
  args: {
    readonly threadId: string;
    readonly excludeRunId?: string;
  },
): Promise<boolean> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, args.threadId),
        args.excludeRunId === undefined
          ? undefined
          : ne(zeroRuns.id, args.excludeRunId),
        inArray(agentRuns.status, ACTIVE_CHAT_RUN_STATUSES),
        or(
          notExists(
            db
              .select({ id: agentRunCallbacks.id })
              .from(agentRunCallbacks)
              .where(
                and(
                  eq(agentRunCallbacks.runId, zeroRuns.id),
                  eq(agentRunCallbacks.internalKind, "chat"),
                  isNotNull(
                    sql`${agentRunCallbacks.payload}->>'queuedMessageId'`,
                  ),
                ),
              ),
          ),
          exists(
            db
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.runId, zeroRuns.id),
                  eq(chatMessages.role, "user"),
                ),
              ),
          ),
        ),
      ),
    )
    .limit(1);

  return run !== undefined;
}

export async function browserCleanupRequiredForChatThread(
  db: Pick<Db, "select">,
  threadId: string,
): Promise<boolean> {
  const [browser] = await db
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.chatThreadId, threadId),
        or(
          inArray(browserSessions.status, [
            ...BROWSER_ADMISSION_BLOCKING_STATUSES,
          ]),
          exists(
            db
              .select({
                providerSessionId: browserSessionInstances.providerSessionId,
              })
              .from(browserSessionInstances)
              .where(
                and(
                  eq(
                    browserSessionInstances.browserSessionId,
                    browserSessions.id,
                  ),
                  isNull(browserSessionInstances.settledAt),
                ),
              ),
          ),
        ),
      ),
    )
    .limit(1);

  return browser !== undefined;
}

export async function chatThreadAdmissionBlocked(
  db: Pick<Db, "select">,
  args: {
    readonly threadId: string;
    readonly excludeRunId?: string;
  },
): Promise<boolean> {
  if (await activeChatRunExists(db, args)) {
    return true;
  }
  return await browserCleanupRequiredForChatThread(db, args.threadId);
}
