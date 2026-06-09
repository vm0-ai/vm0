import { initClient } from "@ts-rest/core";
import {
  webhookAutomationsMainContract,
  webhookAutomationsByIdContract,
} from "@vm0/api-contracts/contracts/webhook-automations";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  WebhookAutomationResponse,
  WebhookAutomationListResponse,
  WebhookAutomationCreateResponse,
} from "@vm0/api-contracts/contracts/webhook-automations";

/**
 * Webhook-automation CLI client. Targets the events-first webhook automations
 * (new `automations` + `automation_triggers` tables) — distinct from the
 * schedule-backed automations in `zero-automations.ts`. Create returns the HMAC
 * secret exactly once; list/get never project it.
 */

/**
 * Create a webhook automation. The response carries the durable projection
 * (including the inbound `webhookUrl`/`webhookToken`) plus the signing `secret`,
 * which is surfaced once and never returned again.
 */
export async function createWebhookAutomation(body: {
  name: string;
  instruction: string;
  agentId: string;
  description?: string;
  enabled?: boolean;
  chatThreadId?: string;
}): Promise<WebhookAutomationCreateResponse> {
  const config = await getClientConfig();
  const client = initClient(webhookAutomationsMainContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create webhook automation");
}

/**
 * List webhook automations for the active org/user. The signing secret is never
 * part of this projection.
 */
export async function listWebhookAutomations(): Promise<WebhookAutomationListResponse> {
  const config = await getClientConfig();
  const client = initClient(webhookAutomationsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list webhook automations");
}

/**
 * Delete a webhook automation by id. Cascades its trigger row (FK ON DELETE
 * CASCADE).
 */
export async function deleteWebhookAutomation(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(webhookAutomationsByIdContract, config);

  const result = await client.delete({ params: { id } });

  if (result.status === 204) {
    return;
  }

  handleError(result, "Failed to delete webhook automation");
}

export type { WebhookAutomationResponse };
