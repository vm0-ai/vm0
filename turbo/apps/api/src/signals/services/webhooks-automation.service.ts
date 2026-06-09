import { createHmac, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, count, eq, gte } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { decryptStoredSecretValue } from "./crypto.utils";
import { createZeroRun$ } from "./zero-runs-create.service";
import { postAutomationUserMessage } from "../routes/zero-chat-messages";
import {
  WebhookInterpreter,
  type WebhookAutomation,
  type WebhookTriggerEvent,
} from "./automations/webhook-interpreter";

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
 * Dispatch an inbound webhook: resolve the automation by trigger token, verify
 * the HMAC signature, enforce the per-automation rate limit, then interpret the
 * request into an agent run via `WebhookInterpreter` and render it into the
 * linked chat thread. A write `command`: it creates a billable run.
 */
export const dispatchAutomationWebhook$ = command(
  async (
    { set },
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
        agentId: automations.agentId,
        chatThreadId: automations.chatThreadId,
        instruction: automations.instruction,
        orgId: automations.orgId,
        userId: automations.userId,
        enabled: automations.enabled,
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

    if (!row || !row.enabled) {
      return { kind: "not_found" };
    }

    // Signature verification is required: a trigger without a stored secret can
    // never authenticate a caller, so it is unreachable rather than open.
    if (!row.encryptedSecret || !args.signature) {
      return { kind: "unauthorized" };
    }

    const secret = await decryptStoredSecretValue(row.encryptedSecret);
    signal.throwIfAborted();
    const verified = await verifySignature({
      secret,
      signature: args.signature,
      body: args.rawBody,
    });
    signal.throwIfAborted();
    if (!verified) {
      return { kind: "unauthorized" };
    }

    const windowStart = new Date(args.apiStartTime - RATE_LIMIT_WINDOW_MS);
    const [recent] = await db
      .select({ value: count() })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(
        and(
          eq(zeroRuns.chatThreadId, row.chatThreadId),
          eq(zeroRuns.triggerSource, "webhook"),
          gte(agentRuns.createdAt, windowStart),
        ),
      );
    signal.throwIfAborted();
    if ((recent?.value ?? 0) >= RATE_LIMIT_MAX_RUNS) {
      log.warn("Automation webhook rate limited", {
        automationId: row.automationId,
      });
      return { kind: "rate_limited" };
    }

    const automation: WebhookAutomation = {
      id: row.automationId,
      agentId: row.agentId,
      chatThreadId: row.chatThreadId,
      instruction: row.instruction,
    };
    const triggerEvent: WebhookTriggerEvent = {
      headers: args.headers,
      body: safeJsonParse(args.rawBody) ?? args.rawBody,
    };
    const runInput = await new WebhookInterpreter().interpret(
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
