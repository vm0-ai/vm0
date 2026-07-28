import {
  initClient,
  type ServerInferRequest,
  type ServerInferResponseBody,
} from "@vm0/api-contracts/contracts/trpc-contract";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowAutomationsContract,
  type WorkflowFileEntry,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { getClientConfig, handleError } from "../core/client-factory";

export type ZeroWorkflowAutomationCreateRequest = ServerInferRequest<
  typeof zeroWorkflowAutomationsContract.create
>["body"];
export type ZeroWorkflowAutomationUpdateRequest = ServerInferRequest<
  typeof zeroWorkflowAutomationsContract.update
>["body"];
export type ZeroWorkflowAutomationSummary = ServerInferResponseBody<
  typeof zeroWorkflowAutomationsContract.get,
  200
>;
type ZeroWorkflowAutomationListEntry = ServerInferResponseBody<
  typeof zeroWorkflowAutomationsContract.listWorkspace,
  200
>[number];

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
  chatThreadId?: string;
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

export async function listWorkflowAutomations(
  workflowId: string,
): Promise<readonly ZeroWorkflowAutomationSummary[]> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.list({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(
    result,
    `Failed to list automations for workflow "${workflowId}"`,
  );
}

export async function listWorkspaceWorkflowAutomations(): Promise<
  readonly ZeroWorkflowAutomationListEntry[]
> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.listWorkspace({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list workflow automations");
}

export async function createWorkflowAutomation(
  workflowId: string,
  body: ZeroWorkflowAutomationCreateRequest,
): Promise<ZeroWorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.create({ params: { workflowId }, body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to add automation to workflow "${workflowId}"`);
}

export async function getWorkflowAutomation(
  id: string,
): Promise<ZeroWorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Workflow automation "${id}" not found`);
}

export async function updateWorkflowAutomation(
  id: string,
  body: ZeroWorkflowAutomationUpdateRequest,
): Promise<ZeroWorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.update({ params: { id }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update workflow automation "${id}"`);
}

export async function deleteWorkflowAutomation(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.delete({ params: { id } });
  if (result.status === 204) return;
  handleError(result, `Workflow automation "${id}" not found`);
}

export async function enableWorkflowAutomation(
  id: string,
): Promise<ZeroWorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.enable({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to enable workflow automation "${id}"`);
}

export async function disableWorkflowAutomation(
  id: string,
): Promise<ZeroWorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(zeroWorkflowAutomationsContract, config);
  const result = await client.disable({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to disable workflow automation "${id}"`);
}
