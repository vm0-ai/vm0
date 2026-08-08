/**
 * Test fixtures for retired agent-run API capabilities.
 *
 * Production no longer exposes direct-run creation or run listing, while the
 * integration suites still need those capabilities to construct and inspect
 * runner state. Keep the exception at this narrow service boundary and assert
 * product behavior through the remaining production routes.
 */
import { createStore } from "ccstate";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { now } from "../lib/time";
import {
  createAgentRun$,
  type CreateAgentRunArgs,
} from "../signals/services/agent-run-create.service";
import { agentRunList } from "../signals/services/zero-runs.service";

const store = createStore();

export type DirectRunFixtureRequest = Omit<
  CreateAgentRunArgs["body"],
  "triggerSource"
> & {
  readonly triggerSource?: TriggerSource;
};

export async function createDirectRunFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly body: DirectRunFixtureRequest;
  readonly signal: AbortSignal;
}) {
  return await store.set(
    createAgentRun$,
    {
      userId: args.userId,
      orgId: args.orgId,
      apiStartTime: now(),
      modelProviderType: args.body.modelProviderType,
      body: {
        ...args.body,
        triggerSource: args.body.triggerSource ?? "test",
      },
    },
    args.signal,
  );
}

export async function listAgentRunsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}) {
  return await store.get(
    agentRunList({
      userId: args.userId,
      orgId: args.orgId,
      status: args.status,
      agent: args.agent,
      since: args.since,
      until: args.until,
      limit: args.limit ?? 50,
    }),
  );
}

/**
 * Age one claimed run without moving the shared test clock. Sweeps that select
 * runs by elapsed runtime are global, so a mocked clock would also age every
 * concurrent test file's rows in the shared database.
 */
export async function backdateRunStartedAtFixture(args: {
  readonly runId: string;
  readonly startedAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({ startedAt: args.startedAt })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to become historical");
  }
}
