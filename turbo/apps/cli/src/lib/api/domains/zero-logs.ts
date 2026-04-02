import { initClient } from "@ts-rest/core";
import {
  logsListContract,
  zeroLogsSearchContract,
  type LogsListResponse,
  type LogsSearchResponse,
  type LogStatus,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listZeroLogs(options?: {
  agent?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}): Promise<LogsListResponse> {
  const config = await getClientConfig();
  const client = initClient(logsListContract, config);
  const result = await client.list({
    query: {
      agent: options?.agent,
      status: options?.status as LogStatus | undefined,
      limit: options?.limit,
      cursor: options?.cursor,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list zero logs");
}

export async function searchZeroLogs(options: {
  keyword: string;
  agent?: string;
  runId?: string;
  since?: number;
  limit?: number;
  before?: number;
  after?: number;
}): Promise<LogsSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroLogsSearchContract, config);
  const result = await client.searchLogs({
    query: {
      keyword: options.keyword,
      agent: options.agent,
      runId: options.runId,
      since: options.since,
      limit: options.limit,
      before: options.before,
      after: options.after,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to search zero logs");
}
