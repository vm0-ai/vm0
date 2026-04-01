import { computed } from "ccstate";
import { zeroRunNetworkLogsContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";

/**
 * Network logs fetched from Axiom via the zero network API.
 * Returns null if network logs are not available.
 */
export const zeroActivityNetworkLogs$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const client = get(zeroClient$)(zeroRunNetworkLogsContract);
  const result = await client.getNetworkLogs({
    params: { id: runId },
    query: { limit: 500, order: "asc" },
  });

  if (result.status !== 200) {
    return null;
  }
  return result.body;
});
