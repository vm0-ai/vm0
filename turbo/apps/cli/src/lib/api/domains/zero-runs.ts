import { initClient } from "@ts-rest/core";
import {
  zeroRunsMainContract,
  zeroRunsByIdContract,
  zeroRunAgentEventsContract,
  zeroRunContextContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import type {
  AgentEventsResponse,
  CreateRunResponse,
  GetRunResponse,
} from "@vm0/api-contracts/contracts/runs";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { getClientConfig, handleError } from "../core/client-factory";

export async function createZeroRun(body: {
  agentId?: string;
  sessionId?: string;
  checkpointId?: string;
  prompt: string;
  modelProvider?: string;
  tools?: string[];
  settings?: string;
  debugNoMockClaude?: boolean;
}): Promise<CreateRunResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRunsMainContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, "Failed to create zero run");
}

export async function getZeroRun(id: string): Promise<GetRunResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRunsByIdContract, config);
  const result = await client.getById({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get zero run "${id}"`);
}

export async function getZeroRunAgentEvents(
  id: string,
  options?: { since?: number; limit?: number; order?: "asc" | "desc" },
): Promise<AgentEventsResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRunAgentEventsContract, config);
  const result = await client.getAgentEvents({
    params: { id },
    query: {
      since: options?.since,
      limit: options?.limit ?? 100,
      order: options?.order ?? "asc",
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
