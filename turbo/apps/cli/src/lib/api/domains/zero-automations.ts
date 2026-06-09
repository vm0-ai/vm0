import { initClient } from "@ts-rest/core";
import {
  automationsMainContract,
  automationsByNameContract,
  automationsEnableContract,
} from "@vm0/api-contracts/contracts/automations";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  AutomationResponse,
  AutomationListResponse,
  AutomationMutationResponse,
} from "@vm0/api-contracts/contracts/automations";
import { resolveCompose } from "./composes";

/**
 * Deploy a zero automation.
 *
 * The Automations API splits the legacy schedule upsert into create
 * (POST /api/automations) and update (PUT /api/automations/:name). The caller
 * decides which one applies via the `update` flag; both endpoints return the
 * same `{ automation, created }` mutation shape.
 */
export async function deployZeroAutomation(
  body: {
    name: string;
    agentId: string;
    cronExpression?: string;
    atTime?: string;
    intervalSeconds?: number;
    timezone?: string;
    prompt: string;
    description?: string;
    appendSystemPrompt?: string;
    enabled?: boolean;
    chatThreadId?: string;
  },
  options: { update: boolean },
): Promise<AutomationMutationResponse> {
  const config = await getClientConfig();

  if (options.update) {
    const client = initClient(automationsByNameContract, config);
    const { name, ...rest } = body;
    const result = await client.update({ params: { name }, body: rest });

    if (result.status === 200 || result.status === 201) {
      return result.body;
    }

    handleError(result, "Failed to update automation");
  }

  const client = initClient(automationsMainContract, config);
  const result = await client.create({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create automation");
}

/**
 * List all zero automations
 */
export async function listZeroAutomations(): Promise<AutomationListResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list automations");
}

/**
 * Delete zero automation by name
 */
export async function deleteZeroAutomation(params: {
  name: string;
  agentId: string;
}): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(automationsByNameContract, config);

  const result = await client.delete({
    params: { name: params.name },
    query: { agentId: params.agentId },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Automation "${params.name}" not found on remote`);
}

/**
 * Enable zero automation
 */
export async function enableZeroAutomation(params: {
  name: string;
  agentId: string;
}): Promise<AutomationResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsEnableContract, config);

  const result = await client.enable({
    params: { name: params.name },
    body: { agentId: params.agentId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to enable automation "${params.name}"`);
}

/**
 * Disable zero automation
 */
export async function disableZeroAutomation(params: {
  name: string;
  agentId: string;
}): Promise<AutomationResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsEnableContract, config);

  const result = await client.disable({
    params: { name: params.name },
    body: { agentId: params.agentId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable automation "${params.name}"`);
}

/**
 * Resolve a zero automation by agent identifier (UUID or name) using the list
 * API. Searches across all of the user's automations and finds by agentId.
 *
 * Returns the full AutomationResponse so callers can access any field.
 * When an agent has multiple automations, automationName is required for
 * disambiguation. When an agent has exactly one automation, automationName is
 * optional.
 *
 * @throws Error if agent has no automation or disambiguation is needed
 */
export async function resolveZeroAutomationByAgent(
  agentIdentifier: string,
  automationName?: string,
): Promise<AutomationResponse> {
  const compose = await resolveCompose(agentIdentifier);
  if (!compose) {
    throw new Error(`Agent not found: ${agentIdentifier}`);
  }

  const { automations } = await listZeroAutomations();

  const agentAutomations = automations.filter((a) => {
    return a.agentId === compose.id;
  });

  if (agentAutomations.length === 0) {
    throw new Error(`No automation found for agent "${agentIdentifier}"`);
  }

  if (automationName) {
    const match = agentAutomations.find((a) => {
      return a.name === automationName;
    });
    if (!match) {
      const available = agentAutomations
        .map((a) => {
          return a.name;
        })
        .join(", ");
      throw new Error(
        `Automation "${automationName}" not found for agent "${agentIdentifier}". Available automations: ${available}`,
      );
    }
    return match;
  }

  if (agentAutomations.length === 1) {
    return agentAutomations[0]!;
  }

  const available = agentAutomations
    .map((a) => {
      return a.name;
    })
    .join(", ");
  throw new Error(
    `Agent "${agentIdentifier}" has multiple automations. Use --name to specify which one: ${available}`,
  );
}
