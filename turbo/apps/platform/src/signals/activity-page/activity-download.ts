import { command } from "ccstate";
import { zeroRunContextContract, zeroRunNetworkLogsContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import { accept } from "../../lib/accept.ts";
import { fetchAllNetworkLogs } from "./activity-network-signals.ts";

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
      accept(
        get(zeroClient$)(zeroRunContextContract).getContext({
          params: { id: runId },
        }),
        [200],
      ).then((r) => {
        return r.body;
      }),
      fetchAllNetworkLogs(get(zeroClient$)(zeroRunNetworkLogsContract), runId),
    ]);

    if (contextResult.status === "fulfilled" && contextResult.value) {
      extra.context = contextResult.value;
    } else if (contextResult.status === "rejected") {
      L.debug("Failed to fetch context for download", contextResult.reason);
    }

    if (networkResult.status === "fulfilled" && networkResult.value) {
      extra.networkLogs = networkResult.value;
    } else if (networkResult.status === "rejected") {
      L.debug("Failed to fetch network for download", networkResult.reason);
    }

    return extra;
  },
);
