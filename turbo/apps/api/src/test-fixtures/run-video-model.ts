/**
 * Test fixtures for the run video-model snapshot.
 *
 * Retired member defaults cannot be written through the current endpoint, and
 * the snapshot column is write-only until endpoint enforcement lands. These
 * historical-input and snapshot-output cases therefore need direct DB access.
 */
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { zeroRuns } from "@okouai/db/schema/zero-run";
import { eq, sql } from "drizzle-orm";

import { db } from "../lib/db";

export async function setOrgMemberVideoModelFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly selectedVideoModel: string;
}): Promise<void> {
  await db()
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      selectedVideoModel: args.selectedVideoModel,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedVideoModel: args.selectedVideoModel,
        updatedAt: sql`now()`,
      },
    });
}

export async function readRunVideoModelFixture(
  runId: string,
): Promise<string | null> {
  return (await readRunRow(runId)).selectedVideoModel;
}

/** Confirms a run really is threadless before asserting how it resolved. */
export async function readRunChatThreadIdFixture(
  runId: string,
): Promise<string | null> {
  return (await readRunRow(runId)).chatThreadId;
}

async function readRunRow(runId: string): Promise<{
  readonly selectedVideoModel: string | null;
  readonly chatThreadId: string | null;
}> {
  const [run] = await db()
    .select({
      selectedVideoModel: zeroRuns.selectedVideoModel,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error("Expected a Zero run row for the video model snapshot");
  }
  return run;
}
