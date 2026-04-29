import { randomUUID } from "node:crypto";

import type { Store } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { nowDate } from "../../../external/time";

export interface ZeroChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly threadId: string;
}

interface SeedChatThreadOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly title?: string | null;
}

export async function seedZeroChatThread(
  store: Store,
  options: SeedChatThreadOptions = {},
): Promise<ZeroChatThreadFixture> {
  const userId = options.userId ?? `user_${randomUUID()}`;
  const orgId = options.orgId ?? `org_${randomUUID()}`;
  const composeId = randomUUID();
  const threadId = randomUUID();
  const writeDb = store.set(writeDb$);

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: `compose-${composeId.slice(0, 8)}`,
  });
  await writeDb.insert(chatThreads).values({
    id: threadId,
    userId,
    agentComposeId: composeId,
    title: options.title ?? "chat thread",
  });

  return { userId, orgId, composeId, threadId };
}

export async function deleteZeroChatThread(
  store: Store,
  fixture: ZeroChatThreadFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(chatThreads).where(eq(chatThreads.id, fixture.threadId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

interface SeedChatMessageOptions {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly attachFiles?: readonly string[];
  readonly createdAt?: Date;
  readonly sequenceNumber?: number | null;
}

export async function seedZeroChatMessage(
  store: Store,
  fixture: ZeroChatThreadFixture,
  options: SeedChatMessageOptions,
): Promise<string> {
  const id = randomUUID();
  const writeDb = store.set(writeDb$);
  await writeDb.insert(chatMessages).values({
    id,
    chatThreadId: fixture.threadId,
    role: options.role,
    content: options.content,
    attachFiles: options.attachFiles ? [...options.attachFiles] : null,
    sequenceNumber: options.sequenceNumber ?? null,
    createdAt: options.createdAt ?? nowDate(),
  });
  return id;
}
