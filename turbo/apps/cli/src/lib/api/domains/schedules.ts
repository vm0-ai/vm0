import { initClient } from "@ts-rest/core";
import {
  schedulesMainContract,
  schedulesByNameContract,
  schedulesEnableContract,
  scheduleRunsContract,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  ScheduleResponse,
  ScheduleListResponse,
  DeployScheduleResponse,
  ScheduleRunsResponse,
} from "../core/types";

/**
 * Deploy schedule (create or update)
 * Note: vars and secrets are now managed via platform tables (vm0 secret set, vm0 var set)
 */
export async function deploySchedule(body: {
  name: string;
  cronExpression?: string;
  atTime?: string;
  timezone?: string;
  prompt: string;
  // vars and secrets removed - now managed via platform tables
  artifactName?: string;
  artifactVersion?: string;
  volumeVersions?: Record<string, string>;
  composeId: string;
}): Promise<DeployScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(schedulesMainContract, config);

  const result = await client.deploy({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to deploy schedule");
}

/**
 * List all schedules
 */
export async function listSchedules(): Promise<ScheduleListResponse> {
  const config = await getClientConfig();
  const client = initClient(schedulesMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list schedules");
}

/**
 * Get schedule by name
 */
export async function getScheduleByName(params: {
  name: string;
  composeId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(schedulesByNameContract, config);

  const result = await client.getByName({
    params: { name: params.name },
    query: { composeId: params.composeId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Schedule "${params.name}" not found`);
}

/**
 * Delete schedule by name
 */
export async function deleteSchedule(params: {
  name: string;
  composeId: string;
}): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(schedulesByNameContract, config);

  const result = await client.delete({
    params: { name: params.name },
    query: { composeId: params.composeId },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Schedule "${params.name}" not found on remote`);
}

/**
 * Enable schedule
 */
export async function enableSchedule(params: {
  name: string;
  composeId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(schedulesEnableContract, config);

  const result = await client.enable({
    params: { name: params.name },
    body: { composeId: params.composeId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to enable schedule "${params.name}"`);
}

/**
 * Disable schedule
 */
export async function disableSchedule(params: {
  name: string;
  composeId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(schedulesEnableContract, config);

  const result = await client.disable({
    params: { name: params.name },
    body: { composeId: params.composeId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable schedule "${params.name}"`);
}

/**
 * List recent runs for a schedule
 */
export async function listScheduleRuns(params: {
  name: string;
  composeId: string;
  limit?: number;
}): Promise<ScheduleRunsResponse> {
  const config = await getClientConfig();
  const client = initClient(scheduleRunsContract, config);

  const result = await client.listRuns({
    params: { name: params.name },
    query: {
      composeId: params.composeId,
      limit: params.limit ?? 5,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to list runs for schedule "${params.name}"`);
}
