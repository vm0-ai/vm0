import { eq } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  chatThreadEvents,
  type ChatThreadEventKind,
} from "@vm0/db/schema/chat-thread-event";

import type { Db } from "../external/db";

type ChatThreadEventDb = Pick<Db, "insert" | "select">;

export async function appendChatThreadEvent(
  db: ChatThreadEventDb,
  args: {
    readonly kind: ChatThreadEventKind;
    readonly userId: string;
    readonly orgId?: string | null;
    readonly chatThreadId: string;
    readonly agentComposeId: string;
    readonly title?: string | null;
    readonly createdAt?: Date;
  },
): Promise<void> {
  let orgId = args.orgId ?? undefined;
  if (orgId === undefined) {
    const [compose] = await db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, args.agentComposeId))
      .limit(1);
    orgId = compose?.orgId;
  }

  if (orgId === undefined) {
    throw new Error("Unable to resolve org for chat thread event");
  }

  await db.insert(chatThreadEvents).values({
    userId: args.userId,
    orgId,
    chatThreadId: args.chatThreadId,
    kind: args.kind,
    agentComposeId: args.agentComposeId,
    title: args.title ?? null,
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
  });
}
