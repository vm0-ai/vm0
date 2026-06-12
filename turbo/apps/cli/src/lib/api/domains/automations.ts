import { initClient } from "@ts-rest/core";
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
} from "@vm0/api-contracts/contracts/automations";

/**
 * Client for the unified Automation resource API (#16847 slice 2): one
 * automation = identity + intent, carrying N triggers (cron / once / loop /
 * webhook).
 *
 * `ref` is an automation id (UUID) or its unique name; an ambiguous name is
 * rejected by the server with 400. Triggers are addressed by UUID only.
 * Webhook HMAC secrets surface exactly once (creation/rotation responses).
 */

/**
 * Create an automation, optionally with its first trigger. When the trigger is
 * a webhook, the response carries the one-time `webhookSecret`.
 */
export async function createAutomation(body: {
  name: string;
  agentId: string;
  instruction: string;
  description?: string;
  chatThreadId?: string;
  trigger?: CreateTriggerRequest;
}): Promise<{ automation: AutomationResponse; webhookSecret?: string }> {
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
 * Enable an automation (all of its triggers resume)
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
 * Disable an automation (suspends all of its triggers)
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
 * Add a trigger to an automation. When the trigger is a webhook, the response
 * carries the one-time `webhookSecret`.
 */
export async function addAutomationTrigger(
  ref: string,
  body: CreateTriggerRequest,
): Promise<{ trigger: AutomationTriggerResponse; webhookSecret?: string }> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.addTrigger({ params: { ref }, body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, `Failed to add trigger to automation "${ref}"`);
}

/**
 * List an automation's triggers
 */
export async function listAutomationTriggers(ref: string): Promise<{
  triggers: AutomationTriggerResponse[];
}> {
  const config = await getClientConfig();
  const client = initClient(automationsByRefContract, config);

  const result = await client.listTriggers({ params: { ref } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to list triggers of automation "${ref}"`);
}

/**
 * Show a trigger by id
 */
export async function showAutomationTrigger(
  id: string,
): Promise<AutomationTriggerResponse> {
  const config = await getClientConfig();
  const client = initClient(automationTriggersContract, config);

  const result = await client.show({ params: { id } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Trigger not found: ${id}`);
}

/**
 * Remove a trigger by id
 */
export async function removeAutomationTrigger(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(automationTriggersContract, config);

  const result = await client.remove({ params: { id } });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Failed to remove trigger ${id}`);
}

/**
 * Enable a single trigger
 */
export async function enableAutomationTrigger(
  id: string,
): Promise<AutomationTriggerResponse> {
  const config = await getClientConfig();
  const client = initClient(automationTriggersContract, config);

  const result = await client.enable({ params: { id }, body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to enable trigger ${id}`);
}

/**
 * Disable a single trigger
 */
export async function disableAutomationTrigger(
  id: string,
): Promise<AutomationTriggerResponse> {
  const config = await getClientConfig();
  const client = initClient(automationTriggersContract, config);

  const result = await client.disable({ params: { id }, body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to disable trigger ${id}`);
}

/**
 * Rotate a webhook trigger's HMAC secret. The new secret is returned exactly
 * once and is unrecoverable afterwards.
 */
export async function rotateAutomationTriggerSecret(id: string): Promise<{
  trigger: AutomationTriggerResponse;
  webhookSecret?: string;
}> {
  const config = await getClientConfig();
  const client = initClient(automationTriggersContract, config);

  const result = await client.rotateSecret({ params: { id }, body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to rotate secret of trigger ${id}`);
}
