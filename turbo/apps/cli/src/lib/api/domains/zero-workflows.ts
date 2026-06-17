import { initClient } from "@ts-rest/core";
import {
  zeroWorkflowAgentsContract,
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  type WorkflowFileEntry,
  type ZeroWorkflowContentResponse,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listWorkflows(): Promise<ZeroWorkflowSummary[]> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsCollectionContract, config);
  const result = await client.list({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list workflows");
}

export async function createWorkflow(body: {
  name: string;
  files: WorkflowFileEntry[];
  displayName?: string;
  description?: string;
  visibility?: "public" | "private";
}): Promise<ZeroWorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsCollectionContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to create workflow "${body.name}"`);
}

export async function getWorkflow(
  name: string,
): Promise<ZeroWorkflowDetailResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.get({ params: { name } });
  if (result.status === 200) return result.body;
  handleError(result, `Workflow "${name}" not found`);
}

export async function updateWorkflow(
  name: string,
  body: {
    files?: WorkflowFileEntry[];
    displayName?: string | null;
    description?: string | null;
    visibility?: "public" | "private";
  },
): Promise<ZeroWorkflowContentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.update({ params: { name }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update workflow "${name}"`);
}

export async function deleteWorkflow(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.delete({ params: { name } });
  if (result.status === 204) return;
  handleError(result, `Workflow "${name}" not found`);
}

export async function attachWorkflowToAgent(
  name: string,
  agentId: string,
): Promise<ZeroWorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAgentsContract, config);
  const result = await client.attach({
    params: { name },
    body: { agentId },
  });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to attach workflow "${name}"`);
}

export async function detachWorkflowFromAgent(
  name: string,
  agentId: string,
): Promise<ZeroWorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAgentsContract, config);
  const result = await client.detach({
    params: { name, agentId },
  });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to detach workflow "${name}"`);
}

export async function setWorkflowAgents(
  name: string,
  agentIds: string[],
): Promise<ZeroWorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAgentsContract, config);
  const result = await client.set({
    params: { name },
    body: { agentIds },
  });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to set workflow agents for "${name}"`);
}
