import { initClient } from "@ts-rest/core";
import {
  logsListContract,
  type LogsListResponse,
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
