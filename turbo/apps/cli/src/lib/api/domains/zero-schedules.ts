import { initClient } from "@ts-rest/core";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  ScheduleResponse,
  ScheduleListResponse,
  DeployScheduleResponse,
} from "../core/types";

/**
 * Deploy zero schedule (create or update)
 */
export async function deployZeroSchedule(body: {
  name: string;
  zeroAgentId: string;
  cronExpression?: string;
  atTime?: string;
  intervalSeconds?: number;
  timezone?: string;
  prompt: string;
  description?: string;
  appendSystemPrompt?: string;
  artifactName?: string;
  artifactVersion?: string;
  volumeVersions?: Record<string, string>;
  enabled?: boolean;
  notifyEmail?: boolean;
  notifySlack?: boolean;
}): Promise<DeployScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesMainContract, config);

  const result = await client.deploy({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to deploy schedule");
}

/**
 * List all zero schedules
 */
export async function listZeroSchedules(): Promise<ScheduleListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list schedules");
}

/**
 * Delete zero schedule by name
 */
export async function deleteZeroSchedule(params: {
  name: string;
  zeroAgentId: string;
}): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesByNameContract, config);

  const result = await client.delete({
    params: { name: params.name },
    query: { zeroAgentId: params.zeroAgentId },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Schedule "${params.name}" not found on remote`);
}

/**
 * Enable zero schedule
 */
export async function enableZeroSchedule(params: {
  name: string;
  zeroAgentId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesEnableContract, config);

  const result = await client.enable({
    params: { name: params.name },
    body: { zeroAgentId: params.zeroAgentId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to enable schedule "${params.name}"`);
}

/**
 * Disable zero schedule
 */
export async function disableZeroSchedule(params: {
  name: string;
  zeroAgentId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesEnableContract, config);

  const result = await client.disable({
    params: { name: params.name },
    body: { zeroAgentId: params.zeroAgentId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable schedule "${params.name}"`);
}

/**
 * Result of resolving a zero schedule by agent name
 */
interface ResolveZeroScheduleResult {
  name: string;
  zeroAgentId: string;
  agentName: string;
}

/**
 * Resolve a zero schedule by agent name using the list API.
 * Searches across all user's schedules and finds by agentName.
 *
 * When an agent has multiple schedules, scheduleName is required for disambiguation.
 * When an agent has exactly one schedule, scheduleName is optional.
 *
 * @throws Error if agent has no schedule or disambiguation is needed
 */
export async function resolveZeroScheduleByAgent(
  agentName: string,
  scheduleName?: string,
): Promise<ResolveZeroScheduleResult> {
  const { schedules } = await listZeroSchedules();

  const agentSchedules = schedules.filter((s) => s.agentName === agentName);

  if (agentSchedules.length === 0) {
    throw new Error(`No schedule found for agent "${agentName}"`);
  }

  if (scheduleName) {
    const match = agentSchedules.find((s) => s.name === scheduleName);
    if (!match) {
      const available = agentSchedules.map((s) => s.name).join(", ");
      throw new Error(
        `Schedule "${scheduleName}" not found for agent "${agentName}". Available schedules: ${available}`,
      );
    }
    return {
      name: match.name,
      zeroAgentId: match.zeroAgentId,
      agentName: match.agentName,
    };
  }

  if (agentSchedules.length === 1) {
    return {
      name: agentSchedules[0]!.name,
      zeroAgentId: agentSchedules[0]!.zeroAgentId,
      agentName: agentSchedules[0]!.agentName,
    };
  }

  const available = agentSchedules.map((s) => s.name).join(", ");
  throw new Error(
    `Agent "${agentName}" has multiple schedules. Use --name to specify which one: ${available}`,
  );
}
