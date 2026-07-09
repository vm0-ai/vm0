import { randomUUID } from "node:crypto";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { db } from "../lib/db";

export interface LegacyChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly threadId: string;
}

/**
 * Seeds an agent compose, zero agent, and chat thread WITHOUT any
 * chat_thread_events rows.
 *
 * Why product APIs cannot construct this state: every production thread
 * create (`POST /api/zero/chat-threads` and the chat send route) writes a
 * `created` chat-thread event in the same transaction. Threads that exist
 * with no events only occur for legacy rows that predate event sourcing —
 * exactly the state the snapshot-compaction cron must backfill from the base
 * table. The bench suite also uses this to seed its base fixture before bulk
 * row inserts.
 */
export async function seedLegacyChatThread(args: {
  readonly userId?: string;
  readonly orgId?: string;
  readonly title?: string;
}): Promise<LegacyChatThreadFixture> {
  const userId = args.userId ?? `user_${randomUUID()}`;
  const orgId = args.orgId ?? `org_${randomUUID()}`;
  const composeId = randomUUID();
  const threadId = randomUUID();

  await db()
    .insert(agentComposes)
    .values({
      id: composeId,
      userId,
      orgId,
      name: `compose-${composeId.slice(0, 8)}`,
    });
  await db()
    .insert(zeroAgents)
    .values({
      id: composeId,
      orgId,
      owner: userId,
      name: `agent-${composeId.slice(0, 8)}`,
    });
  await db()
    .insert(chatThreads)
    .values({
      id: threadId,
      userId,
      agentComposeId: composeId,
      title: args.title ?? "chat thread",
    });

  return { userId, orgId, composeId, threadId };
}
