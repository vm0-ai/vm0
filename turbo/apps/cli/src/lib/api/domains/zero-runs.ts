import { initClient } from "@ts-rest/core";
import {
  zeroRunsMainContract,
  zeroRunsByIdContract,
  zeroRunAgentEventsContract,
  type CreateRunResponse,
  type GetRunResponse,
  type AgentEventsResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function createZeroRun(body: {
  agentId?: string;
  sessionId?: string;
  checkpointId?: string;
  prompt: string;
  appendSystemPrompt?: string;
  modelProvider?: string;
  tools?: string[];
  settings?: string;
  checkEnv?: boolean;
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
