import { computed } from "ccstate";
import { zeroRunRunnerContract } from "@vm0/api-contracts/contracts/zero-runs";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";

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
  return result.body;
});
