import { command } from "ccstate";
import { zeroRunContextContract, zeroRunNetworkLogsContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";

const L = logger("ActivityDownload");

/**
 * Fetch context and network data for a run, silently returning null on failure.
 * Used to enrich JSON downloads without blocking or causing errors on load.
 */
export const fetchDownloadExtra$ = command(
  async (
    { get },
    runId: string,
    _signal: AbortSignal,
  ): Promise<{
    context?: unknown;
    networkLogs?: unknown;
  }> => {
    const extra: { context?: unknown; networkLogs?: unknown } = {};

    const [contextResult, networkResult] = await Promise.allSettled([
      get(zeroClient$)(zeroRunContextContract)
        .getContext({ params: { id: runId } })
        .then((r) => {
          return r.status === 200 ? r.body : null;
        }),
      get(zeroClient$)(zeroRunNetworkLogsContract)
        .getNetworkLogs({
          params: { id: runId },
          query: { limit: 500, order: "asc" },
        })
        .then((r) => {
          return r.status === 200 ? r.body : null;
        }),
    ]);

    if (contextResult.status === "fulfilled" && contextResult.value) {
      extra.context = contextResult.value;
    } else if (contextResult.status === "rejected") {
      L.debug("Failed to fetch context for download", contextResult.reason);
    }

    if (networkResult.status === "fulfilled" && networkResult.value) {
      extra.networkLogs = networkResult.value.networkLogs;
    } else if (networkResult.status === "rejected") {
      L.debug("Failed to fetch network for download", networkResult.reason);
    }

    return extra;
  },
);
