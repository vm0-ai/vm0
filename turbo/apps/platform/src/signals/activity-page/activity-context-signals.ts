import { computed } from "ccstate";
import { zeroRunContextContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";

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
  const result = await client.getContext({
    params: { id: runId },
  });

  if (result.status !== 200) {
    return null;
  }
  return result.body;
});
