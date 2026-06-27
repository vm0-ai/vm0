import { computed } from "ccstate";
import { zeroRunRunnerContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { SandboxReuseResult } from "@vm0/api-contracts/contracts/webhooks";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";

interface ZeroActivityRunner {
  runId: string;
  runner: {
    sandboxReuseResult: SandboxReuseResult | null;
  };
}

export const zeroActivityRunner$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const client = get(zeroClient$)(zeroRunRunnerContract);
  const result = await accept(
    client.getRunner({ params: { id: runId } }),
    [200],
  );
  return {
    runId,
    runner: result.body,
  } satisfies ZeroActivityRunner;
});
