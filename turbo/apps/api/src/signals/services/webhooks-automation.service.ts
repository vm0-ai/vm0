import { createHmac, timingSafeEqual } from "node:crypto";

import { command, computed } from "ccstate";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, count, eq, gte } from "drizzle-orm";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { decryptStoredSecretValue } from "./crypto.utils";
import { createZeroRun$ } from "./zero-runs-create.service";
import { postAutomationUserMessage } from "../routes/zero-chat-messages";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  DefaultInterpreter,
  webhookRowToAutomation,
  type WebhookTriggerEvent,
} from "./automations/default-interpreter";

const log = logger("api:webhooks:automation");

/**
 * Per-automation inbound rate limit: at most this many webhook runs may be
 * created for one automation's linked thread within the rolling window. This is
 * a minimal, bounded throttle (no external infra) guarding a billable endpoint;
 * it counts recent `zero_runs` rather than reserving a quota.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_RUNS = 10;

/** The HMAC signature header, `sha256=<hex>` (mirrors the GitHub webhook). */
export const SIGNATURE_HEADER = "x-vm0-signature-256";

/**
 * Outcome of an inbound webhook dispatch, mapped to an HTTP response by the
 * route. `not_found` collapses missing tokens and disabled automations so an
 * unguessable token leaks nothing; `unauthorized` covers missing or mismatched
 * signatures; `rate_limited` is the bounded per-automation throttle.
 */
type AutomationWebhookResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "run_error"; readonly message: string };

/**
 * Verify an HMAC-SHA256 signature (`sha256=<hex>`) of the raw body against the
 * automation's stored secret. `timingSafeEqual` throws when the buffers differ
 * in length, so the comparison runs inside `settle` and a throw maps to a
 * non-match (the GitHub webhook verify pattern).
 */
async function verifySignature(args: {
  readonly secret: string;
  readonly signature: string;
  readonly body: string;
}): Promise<boolean> {
  const expected = `sha256=${createHmac("sha256", args.secret)
    .update(args.body)
    .digest("hex")}`;
  const result = await settle(
    (async (): Promise<boolean> => {
      await Promise.resolve();
      return timingSafeEqual(
        Buffer.from(args.signature),
        Buffer.from(expected),
      );
    })(),
  );
  return result.ok ? result.value : false;
}

/**
 * Bounded per-automation throttle: counts recent webhook runs in the
 * automation's linked thread within the rolling window.
 */
async function isWebhookRateLimited(
  db: Db,
  chatThreadId: string,
  apiStartTime: number,
): Promise<boolean> {
  const windowStart = new Date(apiStartTime - RATE_LIMIT_WINDOW_MS);
  const [recent] = await db
    .select({ value: count() })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, chatThreadId),
        eq(zeroRuns.triggerSource, "webhook"),
        gte(agentRuns.createdAt, windowStart),
      ),
    );
  return (recent?.value ?? 0) >= RATE_LIMIT_MAX_RUNS;
}

// Signature verification is required: a trigger without a stored secret can
// never authenticate a caller, so it is unreachable rather than open.
async function verifyInboundSignature(args: {
  readonly encryptedSecret: string | null;
  readonly signature: string | null;
  readonly rawBody: string;
}): Promise<boolean> {
  if (!args.encryptedSecret || !args.signature) {
    return false;
  }
  const secret = await decryptStoredSecretValue(args.encryptedSecret);
  return await verifySignature({
    secret,
    signature: args.signature,
    body: args.rawBody,
  });
}

// Webhook triggers are feature-gated (#17307). Inbound calls carry no
// requester auth, so the switch is evaluated against the automation's owner.
function webhookTriggersEnabledForOwner(orgId: string, userId: string) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.AutomationWebhookTriggers, {
      orgId,
      userId,
      overrides,
    });
  });
}

/**
 * Dispatch an inbound webhook: resolve the automation by trigger token, verify
 * the HMAC signature, enforce the per-automation rate limit, then interpret the
 * request into an agent run via the default interpreter (webhook trigger event)
 * and render it into the linked chat thread. A write `command`: it creates a
 * billable run.
 */
export const dispatchAutomationWebhook$ = command(
  async (
    { get, set },
    args: {
      readonly token: string;
      readonly signature: string | null;
      readonly headers: Record<string, string>;
      readonly rawBody: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<AutomationWebhookResult> => {
    const db = set(writeDb$);

    const [row] = await db
      .select({
        automationId: automations.id,
        triggerId: automationTriggers.id,
        agentId: automations.agentId,
        chatThreadId: automations.chatThreadId,
        instruction: automations.instruction,
        appendSystemPrompt: automations.appendSystemPrompt,
        orgId: automations.orgId,
        userId: automations.userId,
        enabled: automations.enabled,
        triggerEnabled: automationTriggers.enabled,
        encryptedSecret: automationTriggers.encryptedSecret,
      })
      .from(automationTriggers)
      .innerJoin(
        automations,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(eq(automationTriggers.webhookToken, args.token))
      .limit(1);
    signal.throwIfAborted();

    // A run fires only when automation.enabled && trigger.enabled (B3 on
    // #16847): the automation-level switch suspends all triggers, the
    // trigger-level switch disables just this inbound hook.
    if (!row || !row.enabled || !row.triggerEnabled) {
      return { kind: "not_found" };
    }

    const gateEnabled = await get(
      webhookTriggersEnabledForOwner(row.orgId, row.userId),
    );
    signal.throwIfAborted();
    if (!gateEnabled) {
      return { kind: "not_found" };
    }

    const authorized = await verifyInboundSignature({
      encryptedSecret: row.encryptedSecret,
      signature: args.signature,
      rawBody: args.rawBody,
    });
    signal.throwIfAborted();
    if (!authorized) {
      return { kind: "unauthorized" };
    }

    const rateLimited = await isWebhookRateLimited(
      db,
      row.chatThreadId,
      args.apiStartTime,
    );
    signal.throwIfAborted();
    if (rateLimited) {
      log.warn("Automation webhook rate limited", {
        automationId: row.automationId,
      });
      return { kind: "rate_limited" };
    }

    const automation = webhookRowToAutomation({
      id: row.automationId,
      agentId: row.agentId,
      orgId: row.orgId,
      userId: row.userId,
      chatThreadId: row.chatThreadId,
      instruction: row.instruction,
      appendSystemPrompt: row.appendSystemPrompt,
    });
    const triggerEvent: WebhookTriggerEvent = {
      kind: "webhook",
      triggerId: row.triggerId,
      headers: args.headers,
      body: safeJsonParse(args.rawBody) ?? args.rawBody,
    };
    const runInput = await new DefaultInterpreter().interpret(
      automation,
      triggerEvent,
    );
    signal.throwIfAborted();

    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: row.orgId,
          orgRole: "member",
          userId: row.userId,
          tokenType: "session",
        },
        body: {
          prompt: runInput.prompt,
          agentId: runInput.agentId,
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "webhook",
        chatThreadId: runInput.chatThreadId,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      log.error("Automation webhook run creation failed", {
        automationId: row.automationId,
        status: result.status,
      });
      return { kind: "run_error", message: "Failed to start automation run" };
    }

    await postAutomationUserMessage({
      db,
      threadId: runInput.chatThreadId,
      userId: row.userId,
      runId: result.body.runId,
      prompt: runInput.prompt,
      appendQueueMarker: result.body.status === "queued",
    });
    signal.throwIfAborted();

    return { kind: "ok", runId: result.body.runId };
  },
);
