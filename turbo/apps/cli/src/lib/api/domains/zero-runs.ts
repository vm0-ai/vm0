import { initClient } from "@ts-rest/core";
import {
  zeroRunAgentEventsContract,
  zeroRunContextContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import type { AgentEventsResponse } from "@vm0/api-contracts/contracts/runs";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { getClientConfig, handleError } from "../core/client-factory";

interface LogPaginationOptions {
  readonly since?: number;
  readonly sinceTime?: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

export async function getZeroRunAgentEvents(
  id: string,
  options?: LogPaginationOptions,
): Promise<AgentEventsResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRunAgentEventsContract, config);
  const result = await client.getAgentEvents({
    params: { id },
    query: {
      since: options?.since,
      sinceTime: options?.sinceTime,
      cursor: options?.cursor,
      limit: options?.limit,
      order: options?.order,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get zero run events for "${id}"`);
}

export async function getZeroRunContext(
  id: string,
): Promise<RunContextResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRunContextContract, config);
  const result = await client.getContext({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get zero run context for "${id}"`);
}
