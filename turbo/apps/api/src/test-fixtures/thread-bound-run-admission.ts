import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";

import { now } from "../lib/time";
import { createAgentRun$ } from "../signals/services/agent-run-create.service";
import { createTestFixtureZeroRun$ } from "../signals/services/zero-runs-create.service";

const USER_ID = "thread-run-invariant-user";
const ORG_ID = "thread-run-invariant-org";

/**
 * Exercise the internal Zero service boundary that public contracts cannot
 * construct: a chat-thread id without an atomic queue association.
 */
export async function createUnassociatedThreadBoundZeroRunFixture(
  chatThreadId: string = randomUUID(),
): Promise<void> {
  await createStore().set(
    createTestFixtureZeroRun$,
    {
      auth: {
        tokenType: "session",
        userId: USER_ID,
        orgId: ORG_ID,
        orgRole: "member",
      },
      body: {
        agentId: "thread-run-invariant-agent",
        prompt: "must be rejected before Zero run preparation",
      },
      apiStartTime: now(),
      chatThreadId,
    },
    new AbortController().signal,
  );
}

/**
 * Exercise the lower agent-run boundary so non-Zero internal callers cannot
 * bypass the same queue-claim invariant.
 */
export async function createUnassociatedThreadBoundAgentRunFixture(
  chatThreadId: string = randomUUID(),
): Promise<void> {
  await createStore().set(
    createAgentRun$,
    {
      userId: USER_ID,
      orgId: ORG_ID,
      body: {
        prompt: "must be rejected before agent run preparation",
        triggerSource: "test",
      },
      apiStartTime: now(),
      chatThreadId,
    },
    new AbortController().signal,
  );
}
