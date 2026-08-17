/**
 * Test fixtures for the dormant run image-model snapshot.
 *
 * PR6 intentionally ships before the preference writers and generation reader.
 * Retired stored IDs and the write-only run output therefore need controlled
 * direct database access in integration tests.
 */
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../lib/db";

export async function setOrgMemberImageModelFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly selectedImageModel: string;
}): Promise<void> {
  await db()
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      selectedImageModel: args.selectedImageModel,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedImageModel: args.selectedImageModel,
        updatedAt: sql`now()`,
      },
    });
}

export async function setChatThreadImageModelFixture(
  chatThreadId: string,
  selectedImageModel: string,
): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ selectedImageModel })
    .where(eq(chatThreads.id, chatThreadId));
}

export async function readRunImageModelFixture(
  runId: string,
): Promise<string | null> {
  return (await readRunRow(runId)).selectedImageModel;
}

export async function readImageModelRunChatThreadIdFixture(
  runId: string,
): Promise<string | null> {
  return (await readRunRow(runId)).chatThreadId;
}

async function readRunRow(runId: string): Promise<{
  readonly selectedImageModel: string | null;
  readonly chatThreadId: string | null;
}> {
  const [run] = await db()
    .select({
      selectedImageModel: agentRuns.selectedImageModel,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  if (!run) {
    throw new Error("Expected a product run row for the image model snapshot");
  }
  return run;
}
