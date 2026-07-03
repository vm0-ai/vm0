import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  zeroGoalsContract,
  type ZeroGoalCreateRequest,
  type ZeroGoalEditRequest,
  type ZeroGoalResponse,
} from "@vm0/api-contracts/contracts/zero-goals";
import { getClientConfig, handleError } from "../core/client-factory";

export async function createGoal(
  body: ZeroGoalCreateRequest,
): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, "Failed to create goal");
}

export async function editGoal(
  body: ZeroGoalEditRequest,
): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.edit({ body });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to edit goal");
}

export async function getGoal(): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.get({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Goal not found");
}

export async function completeGoal(): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.complete({});
  if (result.status === 200) return result.body;
  handleError(result, "Failed to complete goal");
}

export async function blockGoal(): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.block({});
  if (result.status === 200) return result.body;
  handleError(result, "Failed to block goal");
}

export async function pauseGoal(): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.pause({});
  if (result.status === 200) return result.body;
  handleError(result, "Failed to pause goal");
}

export async function resumeGoal(): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.resume({});
  if (result.status === 200) return result.body;
  handleError(result, "Failed to resume goal");
}

export async function clearGoal(): Promise<{ readonly cleared: true }> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.clear({});
  if (result.status === 200) return result.body;
  handleError(result, "Failed to clear goal");
}
