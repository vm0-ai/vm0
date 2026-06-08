import { initClient } from "@ts-rest/core";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  ScheduleResponse,
  ScheduleListResponse,
  DeployScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { resolveCompose } from "./composes";

/**
 * Deploy zero schedule (create or update)
 */
export async function deployZeroSchedule(body: {
  name: string;
  agentId: string;
  cronExpression?: string;
  atTime?: string;
  intervalSeconds?: number;
  timezone?: string;
  prompt: string;
  description?: string;
  appendSystemPrompt?: string;
  volumeVersions?: Record<string, string>;
  enabled?: boolean;
  chatThreadId?: string;
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
  agentId: string;
}): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesByNameContract, config);

  const result = await client.delete({
    params: { name: params.name },
    query: { agentId: params.agentId },
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
  agentId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesEnableContract, config);

  const result = await client.enable({
    params: { name: params.name },
    body: { agentId: params.agentId },
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
  agentId: string;
}): Promise<ScheduleResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSchedulesEnableContract, config);

  const result = await client.disable({
    params: { name: params.name },
    body: { agentId: params.agentId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable schedule "${params.name}"`);
}

/**
 * Resolve a zero schedule by agent identifier (UUID or name) using the list API.
 * Searches across all user's schedules and finds by agentId.
 *
 * Returns the full ScheduleResponse so callers can access any field.
 * When an agent has multiple schedules, scheduleName is required for disambiguation.
 * When an agent has exactly one schedule, scheduleName is optional.
 *
 * @throws Error if agent has no schedule or disambiguation is needed
 */
export async function resolveZeroScheduleByAgent(
  agentIdentifier: string,
  scheduleName?: string,
): Promise<ScheduleResponse> {
  const compose = await resolveCompose(agentIdentifier);
  if (!compose) {
    throw new Error(`Agent not found: ${agentIdentifier}`);
  }

  const { schedules } = await listZeroSchedules();

  const agentSchedules = schedules.filter((s) => {
    return s.agentId === compose.id;
  });

  if (agentSchedules.length === 0) {
    throw new Error(`No schedule found for agent "${agentIdentifier}"`);
  }

  if (scheduleName) {
    const match = agentSchedules.find((s) => {
      return s.name === scheduleName;
    });
    if (!match) {
      const available = agentSchedules
        .map((s) => {
          return s.name;
        })
        .join(", ");
      throw new Error(
        `Schedule "${scheduleName}" not found for agent "${agentIdentifier}". Available schedules: ${available}`,
      );
    }
    return match;
  }

  if (agentSchedules.length === 1) {
    return agentSchedules[0]!;
  }

  const available = agentSchedules
    .map((s) => {
      return s.name;
    })
    .join(", ");
  throw new Error(
    `Agent "${agentIdentifier}" has multiple schedules. Use --name to specify which one: ${available}`,
  );
}
