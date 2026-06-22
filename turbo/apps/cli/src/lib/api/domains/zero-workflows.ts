import { initClient } from "@ts-rest/core";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  type WorkflowFileEntry,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowRunResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerCreateRequest,
  type ZeroWorkflowTriggerSummary,
  type ZeroWorkflowTriggerUpdateRequest,
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

export async function listWorkflowTriggers(
  workflowId: string,
): Promise<readonly ZeroWorkflowTriggerSummary[]> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.list({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to list triggers for workflow "${workflowId}"`);
}

export async function createWorkflowTrigger(
  workflowId: string,
  body: ZeroWorkflowTriggerCreateRequest,
): Promise<ZeroWorkflowTriggerSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.create({ params: { workflowId }, body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to add trigger to workflow "${workflowId}"`);
}

export async function getWorkflowTrigger(
  id: string,
): Promise<ZeroWorkflowTriggerSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Workflow trigger "${id}" not found`);
}

export async function updateWorkflowTrigger(
  id: string,
  body: ZeroWorkflowTriggerUpdateRequest,
): Promise<ZeroWorkflowTriggerSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.update({ params: { id }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update workflow trigger "${id}"`);
}

export async function deleteWorkflowTrigger(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.delete({ params: { id } });
  if (result.status === 204) return;
  handleError(result, `Workflow trigger "${id}" not found`);
}

export async function enableWorkflowTrigger(
  id: string,
): Promise<ZeroWorkflowTriggerSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.enable({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to enable workflow trigger "${id}"`);
}

export async function disableWorkflowTrigger(
  id: string,
): Promise<ZeroWorkflowTriggerSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.disable({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to disable workflow trigger "${id}"`);
}

export async function runWorkflowTrigger(
  id: string,
): Promise<{ readonly runId: string }> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowTriggersContract, config);
  const result = await client.run({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to run workflow trigger "${id}"`);
}
