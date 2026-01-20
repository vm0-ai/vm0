import {
  schedulesMainContract,
  schedulesByNameContract,
  schedulesEnableContract,
  scheduleRunsContract,
  type ScheduleResponse,
  type ScheduleListResponse,
  type DeployScheduleResponse,
  type ScheduleRunsResponse,
} from "@vm0/core";
import {
  getClientConfig,
  createClient,
  handleError,
} from "../core/client-factory";

export async function deploySchedule(body: {
  name: string;
  cronExpression?: string;
  atTime?: string;
  timezone?: string;
  prompt: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  artifactName?: string;
  artifactVersion?: string;
  volumeVersions?: Record<string, string>;
  composeId: string;
}): Promise<DeployScheduleResponse> {
  const config = await getClientConfig();
  const client = createClient(schedulesMainContract, config);

  const result = await client.deploy({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to deploy schedule");
}

export async function listSchedules(): Promise<ScheduleListResponse> {
  const config = await getClientConfig();
  const client = createClient(schedulesMainContract, config);

  const result = await client.list();

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list schedules");
}

export async function getScheduleByName(params: {
  name: string;
  composeId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = createClient(schedulesByNameContract, config);

  const result = await client.getByName({
    params: { name: params.name },
    query: { composeId: params.composeId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Schedule "${params.name}" not found`);
}

export async function deleteSchedule(params: {
  name: string;
  composeId: string;
}): Promise<void> {
  const config = await getClientConfig();
  const client = createClient(schedulesByNameContract, config);

  const result = await client.delete({
    params: { name: params.name },
    query: { composeId: params.composeId },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Schedule "${params.name}" not found on remote`);
}

export async function enableSchedule(params: {
  name: string;
  composeId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = createClient(schedulesEnableContract, config);

  const result = await client.enable({
    params: { name: params.name },
    body: { composeId: params.composeId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to enable schedule "${params.name}"`);
}

export async function disableSchedule(params: {
  name: string;
  composeId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = createClient(schedulesEnableContract, config);

  const result = await client.disable({
    params: { name: params.name },
    body: { composeId: params.composeId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable schedule "${params.name}"`);
}

export async function listScheduleRuns(params: {
  name: string;
  composeId: string;
  limit?: number;
}): Promise<ScheduleRunsResponse> {
  const config = await getClientConfig();
  const client = createClient(scheduleRunsContract, config);

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
