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
