import { randomUUID } from "node:crypto";

import type { Store } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { now } from "../../../external/time";

export interface QueuePositionFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly queuedRunIds: readonly string[];
  readonly unqueuedRunIds: readonly string[];
}

interface QueuePositionSeedValues {
  readonly queuedRuns?: number;
  readonly unqueuedRuns?: number;
}

async function seedRun(
  store: Store,
  values: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId: string;
    readonly status: string;
  },
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const runId = randomUUID();
  const sessionId = randomUUID();

  await writeDb.insert(agentSessions).values({
    id: sessionId,
    userId: values.userId,
    orgId: values.orgId,
    agentComposeId: values.composeId,
  });
  await writeDb.insert(agentRuns).values({
    id: runId,
    userId: values.userId,
    orgId: values.orgId,
    sessionId,
    status: values.status,
    prompt: "test prompt",
  });

  return runId;
}

export async function seedQueuePositionRuns(
  store: Store,
  values: QueuePositionSeedValues = {},
): Promise<QueuePositionFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const composeId = randomUUID();
  const queuedRuns = values.queuedRuns ?? 0;
  const unqueuedRuns = values.unqueuedRuns ?? 0;
  const queuedRunIds: string[] = [];
  const unqueuedRunIds: string[] = [];
  const writeDb = store.set(writeDb$);

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: `agent-${composeId.slice(0, 8)}`,
  });

  const baseTime = now();
  for (let index = 0; index < queuedRuns; index++) {
    const runId = await seedRun(store, {
      orgId,
      userId,
      composeId,
      status: "queued",
    });
    const createdAt = new Date(baseTime + index * 1000);
    await writeDb.insert(agentRunQueue).values({
      runId,
      userId,
      orgId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
    });

    queuedRunIds.push(runId);
  }

  for (let index = 0; index < unqueuedRuns; index++) {
    const runId = await seedRun(store, {
      orgId,
      userId,
      composeId,
      status: "running",
    });
    unqueuedRunIds.push(runId);
  }

  return {
    orgId,
    userId,
    composeId,
    queuedRunIds,
    unqueuedRunIds,
  };
}

export async function deleteQueuePositionRuns(
  store: Store,
  fixture: QueuePositionFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(agentRunQueue)
    .where(eq(agentRunQueue.orgId, fixture.orgId));
  await writeDb.delete(agentRuns).where(eq(agentRuns.orgId, fixture.orgId));
  await writeDb
    .delete(agentSessions)
    .where(eq(agentSessions.orgId, fixture.orgId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}
