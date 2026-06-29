import { command } from "ccstate";
import {
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import { accept } from "../../lib/accept.ts";
import { fetchAllNetworkLogs } from "./activity-network-signals.ts";

const L = logger("ActivityDownload");

/**
 * Fetch optional context and network data for a run. Failures leave the
 * corresponding extra field absent so JSON downloads still complete.
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

    const fetchContextBody = async (): Promise<unknown | undefined> => {
      const result = await accept(
        get(zeroClient$)(zeroRunContextContract).getContext({
          params: { id: runId },
          fetchOptions: { signal: _signal },
        }),
        [200, 404],
        { toast: false },
      );
      return result.status === 200 ? result.body : undefined;
    };

    const [contextResult, networkResult] = await Promise.allSettled([
      fetchContextBody(),
      fetchAllNetworkLogs(
        get(zeroClient$)(zeroRunNetworkLogsContract),
        runId,
        _signal,
        { toast: false },
      ),
    ]);
    _signal.throwIfAborted();

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
