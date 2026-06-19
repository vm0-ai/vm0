import { initClient } from "@ts-rest/core";
import {
  zeroGoalsContract,
  type ZeroGoalCreateRequest,
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

export async function resumeGoal(): Promise<ZeroGoalResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroGoalsContract, config);
  const result = await client.resume({});
  if (result.status === 200) return result.body;
  handleError(result, "Failed to resume goal");
}
