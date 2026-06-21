import { initClient } from "@ts-rest/core";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  type WorkflowFileEntry,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowRunResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listWorkflows(query: {
  agentId?: string;
}): Promise<ZeroWorkflowSummary[]> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsCollectionContract, config);
  const result = await client.list({ query });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list workflows");
}

export async function createWorkflow(body: {
  agentId: string;
  name: string;
  instruction?: string;
  files?: WorkflowFileEntry[];
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
  workflowId: string,
): Promise<ZeroWorkflowDetailResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.get({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(result, `Workflow "${workflowId}" not found`);
}

export async function updateWorkflow(
  workflowId: string,
  body: {
    instruction?: string | null;
    files?: WorkflowFileEntry[];
    displayName?: string | null;
    description?: string | null;
  },
): Promise<ZeroWorkflowDetailResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.update({ params: { workflowId }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update workflow "${workflowId}"`);
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.delete({ params: { workflowId } });
  if (result.status === 204) return;
  handleError(result, `Workflow "${workflowId}" not found`);
}

export async function copyWorkflow(
  workflowId: string,
  toAgentId: string,
): Promise<ZeroWorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.copy({
    params: { workflowId },
    body: { toAgentId },
  });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to copy workflow "${workflowId}"`);
}

export async function runWorkflow(
  workflowId: string,
): Promise<ZeroWorkflowRunResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowsDetailContract, config);
  const result = await client.run({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to run workflow "${workflowId}"`);
}
