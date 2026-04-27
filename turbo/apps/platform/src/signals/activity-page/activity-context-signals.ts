import { computed } from "ccstate";
import { zeroRunContextContract } from "@vm0/api-contracts/contracts/zero-runs";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";

/**
 * Run context snapshot fetched from Axiom via the context API.
 * Returns null if context is not available (old runs or ingestion delay).
 */
export const zeroActivityContext$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const client = get(zeroClient$)(zeroRunContextContract);
  const result = await accept(
    client.getContext({ params: { id: runId } }),
    [200],
  );
  return result.body;
});
