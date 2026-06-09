import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq } from "drizzle-orm";

import { internalApiBaseUrl } from "../../lib/internal-api-url";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import { visibleJoinedZeroAgentCondition } from "./zero-agent-data.service";

/** Interpreter key persisted for webhook automations. */
const WEBHOOK_INTERPRETER_KIND = "webhook";
/** Trigger-kind discriminator for the webhook event source. */
const WEBHOOK_TRIGGER_KIND = "webhook";

/**
 * Durable projection of a webhook automation joined to its trigger token. This
 * is what list/create return; the HMAC secret is deliberately absent — it is
 * surfaced once at creation by the service and never persisted in plaintext.
 */
export interface WebhookAutomationView {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly name: string;
  readonly instruction: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly chatThreadId: string;
  readonly webhookToken: string;
  readonly webhookUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AutomationRow {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly name: string;
  readonly instruction: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly chatThreadId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Full inbound URL a signed payload is POSTed to for the given token. */
function webhookUrlForToken(token: string): string {
  return `${internalApiBaseUrl()}/api/automations/webhooks/${token}`;
}

function toView(
  row: AutomationRow,
  webhookToken: string,
): WebhookAutomationView {
  return {
    id: row.id,
    agentId: row.agentId,
    userId: row.userId,
    name: row.name,
    instruction: row.instruction,
    description: row.description,
    enabled: row.enabled,
    chatThreadId: row.chatThreadId,
    webhookToken,
    webhookUrl: webhookUrlForToken(webhookToken),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Columns of the `automations` row used to build a view. Kept to the
// automations table only so it is valid both as an insert `.returning()` and as
// the automation half of the list join (the trigger token is selected/passed
// separately).
const automationViewColumns = {
  id: automations.id,
  agentId: automations.agentId,
  userId: automations.userId,
  name: automations.name,
  instruction: automations.instruction,
  description: automations.description,
  enabled: automations.enabled,
  chatThreadId: automations.chatThreadId,
  createdAt: automations.createdAt,
  updatedAt: automations.updatedAt,
} as const;

/**
 * Load an agent the user may target, scoped to the org and the user's
 * visibility. Mirrors the schedule deploy's agent gate so webhook automations
 * cannot be attached to agents the caller cannot see.
 */
async function loadTargetAgent(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<{ readonly id: string } | null> {
  const [agent] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.id, args.agentId),
        visibleJoinedZeroAgentCondition(args.userId),
      ),
    )
    .limit(1);
  return agent ?? null;
}

/**
 * A chat thread may be linked to a webhook automation only if it exists, is
 * owned by the same user, and belongs to the same agent. (Chat threads carry
 * only a userId, so org isolation is enforced via the user — same rule the
 * schedule surface applies.)
 */
async function isChatThreadLinkable(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [thread] = await db
    .select({
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.chatThreadId))
    .limit(1);
  return (
    thread !== undefined &&
    thread.userId === args.userId &&
    thread.agentComposeId === args.agentId
  );
}

interface CreateWebhookAutomationBody {
  readonly name: string;
  readonly instruction: string;
  readonly description?: string;
  readonly agentId: string;
  readonly enabled?: boolean;
  readonly chatThreadId?: string;
}

type CreateWebhookAutomationResult =
  | {
      readonly kind: "ok";
      readonly automation: WebhookAutomationView;
      readonly secret: string;
    }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "bad_request"; readonly message: string };

/**
 * Create a webhook automation: validate the target agent, resolve a linked chat
 * thread (an owned existing thread or a server-created one), mint an unguessable
 * URL token and an HMAC signing secret, and persist `automations` plus a
 * `automation_triggers(kind:"webhook")` row in one transaction. The signing
 * secret is encrypted at rest and returned once to the caller; only the token
 * (identity) is durable. A write `command`.
 */
export const createWebhookAutomation$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly body: CreateWebhookAutomationBody;
    },
    signal: AbortSignal,
  ): Promise<CreateWebhookAutomationResult> => {
    const db = set(writeDb$);

    const agent = await loadTargetAgent(db, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.body.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "not_found", message: "Agent not found" };
    }

    if (args.body.chatThreadId !== undefined) {
      const linkable = await isChatThreadLinkable(db, {
        chatThreadId: args.body.chatThreadId,
        userId: args.userId,
        agentId: args.body.agentId,
      });
      signal.throwIfAborted();
      if (!linkable) {
        return {
          kind: "bad_request",
          message:
            "Chat thread not found, not owned by this user, or belongs to a different agent",
        };
      }
    }

    // Unguessable URL token (identity) and HMAC signing secret (authentication).
    // The token is stored in the clear for O(1) inbound lookup; the secret is
    // encrypted at rest and shown to the caller exactly once below. 24 random
    // bytes (192 bits) render as a 48-char hex string; the `whk_` prefix keeps
    // the whole token within the trigger's varchar(64) webhook_token column.
    const webhookToken = `whk_${randomBytes(24).toString("hex")}`;
    const secret = randomBytes(32).toString("hex");
    const encryptedSecret = await encryptStoredSecretValue(secret);
    signal.throwIfAborted();

    const currentTime = nowDate();
    const view = await db.transaction(async (tx) => {
      let chatThreadId = args.body.chatThreadId;
      if (chatThreadId === undefined) {
        const [thread] = await tx
          .insert(chatThreads)
          .values({
            userId: args.userId,
            agentComposeId: args.body.agentId,
            title: args.body.description ?? args.body.name,
            lastMessageAt: currentTime,
            createdAt: currentTime,
            updatedAt: currentTime,
          })
          .returning({ id: chatThreads.id });
        if (!thread) {
          throw new Error("Failed to create chat thread");
        }
        chatThreadId = thread.id;
      }

      const [automation] = await tx
        .insert(automations)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          name: args.body.name,
          description: args.body.description ?? null,
          instruction: args.body.instruction,
          agentId: args.body.agentId,
          chatThreadId,
          interpreterKind: WEBHOOK_INTERPRETER_KIND,
          enabled: args.body.enabled ?? true,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .returning(automationViewColumns);
      if (!automation) {
        throw new Error("Failed to create automation");
      }

      await tx.insert(automationTriggers).values({
        automationId: automation.id,
        kind: WEBHOOK_TRIGGER_KIND,
        webhookToken,
        encryptedSecret,
        createdAt: currentTime,
        updatedAt: currentTime,
      });

      return toView(automation, webhookToken);
    });
    signal.throwIfAborted();

    return { kind: "ok", automation: view, secret };
  },
);

/**
 * List the caller's webhook automations on the new tables, scoped to (orgId,
 * userId) and newest first. The signing secret is never projected — only the
 * token and its inbound URL.
 */
export const listWebhookAutomations$ = command(
  async (
    { set },
    args: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<readonly WebhookAutomationView[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        ...automationViewColumns,
        webhookToken: automationTriggers.webhookToken,
      })
      .from(automations)
      .innerJoin(
        automationTriggers,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(
        and(
          eq(automations.orgId, args.orgId),
          eq(automations.userId, args.userId),
          eq(automations.interpreterKind, WEBHOOK_INTERPRETER_KIND),
        ),
      )
      .orderBy(desc(automations.createdAt));
    signal.throwIfAborted();
    return rows.flatMap(({ webhookToken, ...row }) => {
      // A webhook trigger always carries a token; skip any row without one
      // rather than surface a tokenless (unusable) URL.
      return webhookToken === null ? [] : [toView(row, webhookToken)];
    });
  },
);

type DeleteWebhookAutomationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" };

/**
 * Delete a webhook automation by id, scoped to the caller. The trigger row is
 * removed by the FK cascade. A write `command`.
 */
export const deleteWebhookAutomation$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<DeleteWebhookAutomationResult> => {
    const db = set(writeDb$);
    const [deleted] = await db
      .delete(automations)
      .where(
        and(
          eq(automations.id, args.id),
          eq(automations.orgId, args.orgId),
          eq(automations.userId, args.userId),
          eq(automations.interpreterKind, WEBHOOK_INTERPRETER_KIND),
        ),
      )
      .returning({ id: automations.id });
    signal.throwIfAborted();
    if (!deleted) {
      return { kind: "not_found" };
    }
    return { kind: "ok" };
  },
);
