import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  automationsMainContract,
  automationsByRefContract,
  automationTriggersContract,
} from "@vm0/api-contracts/contracts/automations";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  AutomationResponse,
  AutomationTriggerResponse,
  CreateTriggerRequest,
  UpdateTriggerRequest,
} from "@vm0/api-contracts/contracts/automations";

/**
 * Client for the unified Automation resource API (#16847 slice 2): one
 * automation = identity + intent, carrying one schedule trigger (cron / once /
 * loop).
 *
 * `ref` is an automation id (UUID) or its unique name; an ambiguous name is
 * rejected by the server with 400. Triggers are addressed by UUID only.
 */

/** Create an automation with its schedule trigger. */
export async function createAutomation(body: {
  name: string;
  agentId: string;
  instruction: string;
  description?: string;
  chatThreadId?: string;
  trigger: CreateTriggerRequest;
}): Promise<{ automation: AutomationResponse }> {
  const config = await getClientConfig();
  const client = initClient(automationsMainContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create automation");
}

/**
 * List automations with their triggers
 */
export async function listAutomations(): Promise<{
  automations: AutomationResponse[];
}> {
  const config = await getClientConfig();
  const client = initClient(automationsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list automations");
}

/**
 * Show an automation (and its triggers) by id or name
 */
export async function showAutomation(ref: string): Promise<AutomationResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.show({ params: { ref } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Automation not found: ${ref}`);
}

/**
 * Update an automation's identity/intent fields
 */
export async function updateAutomation(
  ref: string,
  body: {
    name?: string;
    instruction?: string;
    description?: string;
  },
): Promise<AutomationResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.update({ params: { ref }, body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to update automation "${ref}"`);
}

/**
 * Delete an automation (its triggers cascade)
 */
export async function deleteAutomation(ref: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.delete({ params: { ref } });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Failed to delete automation "${ref}"`);
}

/**
 * Enable an automation.
 */
export async function enableAutomation(
  ref: string,
): Promise<AutomationResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.enable({ params: { ref }, body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to enable automation "${ref}"`);
}

/**
 * Disable an automation.
 */
export async function disableAutomation(
  ref: string,
): Promise<AutomationResponse> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.disable({ params: { ref }, body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable automation "${ref}"`);
}

/**
 * Manually fire an automation (instruction-only, no event payload)
 */
export async function runAutomation(ref: string): Promise<{ runId: string }> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.run({ params: { ref }, body: {} });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, `Failed to run automation "${ref}"`);
}

/**
 * Replace a time trigger's schedule config in place (the kind may switch
 * among cron/once/loop). The trigger keeps its id, enabled flag, and run
 * history; the next run is recomputed and the failure counter resets.
 */
export async function updateAutomationTrigger(
  id: string,
  body: UpdateTriggerRequest,
): Promise<AutomationTriggerResponse> {
  const config = await getClientConfig();
  const client = initClient(automationTriggersContract, config);

  const result = await client.update({ params: { id }, body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to update trigger ${id}`);
}
