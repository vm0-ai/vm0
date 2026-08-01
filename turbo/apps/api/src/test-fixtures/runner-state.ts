import type {
  RunnerHeldSessionStates,
  RunnerHeldWorkspaceStates,
} from "@vm0/db/jsonb-contracts/runner-state";
import { runnerState } from "@vm0/db/schema/runner-state";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

interface RunnerHeldStateFixture {
  readonly heldSessionStates: RunnerHeldSessionStates;
  readonly heldWorkspaceStates: RunnerHeldWorkspaceStates;
}

export async function readRunnerHeldStateFixture(
  runnerId: string,
): Promise<RunnerHeldStateFixture> {
  const [state] = await createStore()
    .set(writeDb$)
    .select({
      heldSessionStates: runnerState.heldSessionStates,
      heldWorkspaceStates: runnerState.heldWorkspaceStates,
    })
    .from(runnerState)
    .where(eq(runnerState.runnerId, runnerId))
    .limit(1);
  if (!state) {
    throw new Error(`Runner state ${runnerId} does not exist`);
  }
  return state;
}
