import { command } from "ccstate";
import type {
  CreateTriggerRequest,
  UpdateTriggerRequest,
} from "@vm0/api-contracts/contracts/automations";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { publishChatThreadAutomationsChangedSafely } from "../external/realtime";
import { isValidTimeZone, settle } from "../utils";
import {
  automationRowToManualAutomation,
  DefaultInterpreter,
} from "./automations/default-interpreter";
import { calculateNextRun } from "./automations/time-trigger";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  isChatThreadLinkable,
  mintWebhookSecret,
  mintWebhookToken,
} from "./webhook-automations.service";
import {
  loadAgentForDeploy,
  persistManualRunSideEffects,
  resolveAutomationRunModelContext,
  type RunCreationErrorResponse,
} from "./automations/run-compat";
import { createZeroRun$ } from "./zero-runs-create.service";
import { generateAutomationDescription } from "./automations/describe";

/**
 * Interpreter key persisted for natively-created automations (D1 on
 * #16847): the single default interpreter handles every kind, so new
 * automations stop pretending to be kind-specific. The old surfaces keep
 * writing "time"/"webhook" for now; nothing branches on the column.
 */
const DEFAULT_INTERPRETER_KIND = "default";

/** The time-trigger kinds whose next run is recomputed on enable. */
const TIME_TRIGGER_KINDS = ["cron", "once", "loop"] as const;

export type AutomationRow = typeof automations.$inferSelect;
export type AutomationTriggerRow = typeof automationTriggers.$inferSelect;

/**
 * An automation as the automation resource API projects it: the automation row (identity +
 * intent), its agent display name, and ALL its trigger rows (any kind).
 */
export interface AutomationView {
  readonly automation: AutomationRow;
  readonly displayName: string | null;
  readonly triggers: readonly AutomationTriggerRow[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResolveRefResult =
  | {
      readonly kind: "ok";
      readonly automation: AutomationRow;
      readonly displayName: string | null;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" };

/**
 * Resolve an automation `:ref` — an id (UUID) or a name — within the (orgId,
 * userId) scope. A name shared across agents matches multiple automations
 * (the unique key is (agent, name, org, user)) and is rejected as ambiguous;
 * the caller must use the id.
 */
async function resolveAutomationRef(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly ref: string;
  },
): Promise<ResolveRefResult> {
  const refCondition = UUID_RE.test(args.ref)
    ? eq(automations.id, args.ref)
    : eq(automations.name, args.ref);
  const rows = await db
    .select({ automation: automations, displayName: zeroAgents.displayName })
    .from(automations)
    .leftJoin(zeroAgents, eq(zeroAgents.id, automations.agentId))
    .where(
      and(
        refCondition,
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
      ),
    )
    .limit(2);
  const [first] = rows;
  if (!first) {
    return { kind: "not_found" };
  }
  if (rows.length > 1) {
    return { kind: "ambiguous" };
  }
  return {
    kind: "ok",
    automation: first.automation,
    displayName: first.displayName ?? null,
  };
}

async function loadTriggers(
  db: Db,
  automationId: string,
): Promise<readonly AutomationTriggerRow[]> {
  return await db
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.automationId, automationId))
    .orderBy(asc(automationTriggers.createdAt), asc(automationTriggers.id));
}

/** Trigger insert values minus the automation linkage, plus the one-shot secret. */
interface ResolvedTriggerInsert {
  readonly values: Omit<typeof automationTriggers.$inferInsert, "automationId">;
  readonly webhookSecret?: string;
}

type TriggerInsertResult =
  | { readonly kind: "ok"; readonly insert: ResolvedTriggerInsert }
  | { readonly kind: "bad_request"; readonly message: string };

// `calculateNextRun` throws on a malformed cron expression and returns null
// when the expression has no further occurrences; both collapse to null here
// and surface as a 400 at trigger creation.
async function nextCronOccurrence(
  cronExpression: string,
  timezone: string,
  fromDate: Date,
): Promise<Date | null> {
  const result = await settle(
    (async (): Promise<Date | null> => {
      await Promise.resolve();
      return calculateNextRun(cronExpression, timezone, fromDate);
    })(),
  );
  return result.ok ? result.value : null;
}

/**
 * Validate a trigger-creation request and resolve the row to insert. The B4
 * CHECK constraint requires each kind to carry exactly its own config columns,
 * so only the kind's fields are set. A new trigger is enabled; its first
 * `nextRunAt` follows the creation rules: a cron schedules only while the
 * automation is enabled, a one-time fire is its (future) instant, a loop is
 * due immediately, and a webhook has no time state — it mints the URL token
 * and the once-surfaced HMAC secret instead.
 */
async function resolveTriggerInsert(args: {
  readonly request: CreateTriggerRequest;
  readonly automationEnabled: boolean;
  readonly currentTime: Date;
}): Promise<TriggerInsertResult> {
  const { request, currentTime } = args;
  const timestamps = { createdAt: currentTime, updatedAt: currentTime };

  if (request.kind === "cron" || request.kind === "once") {
    const timezone = request.timezone ?? "UTC";
    if (!isValidTimeZone(timezone)) {
      return { kind: "bad_request", message: `Invalid timezone: ${timezone}` };
    }
    if (request.kind === "cron") {
      const next = await nextCronOccurrence(
        request.cronExpression,
        timezone,
        currentTime,
      );
      if (!next) {
        return {
          kind: "bad_request",
          message: `Invalid cron expression: ${request.cronExpression}`,
        };
      }
      return {
        kind: "ok",
        insert: {
          values: {
            kind: "cron",
            cronExpression: request.cronExpression,
            timezone,
            nextRunAt: args.automationEnabled ? next : null,
            ...timestamps,
          },
        },
      };
    }
    const atTime = new Date(request.atTime);
    if (Number.isNaN(atTime.getTime())) {
      return {
        kind: "bad_request",
        message: `Invalid atTime: ${request.atTime}`,
      };
    }
    if (atTime <= currentTime) {
      return {
        kind: "bad_request",
        message: `Cannot create the trigger: time ${atTime.toISOString()} has already passed`,
      };
    }
    return {
      kind: "ok",
      insert: {
        values: {
          kind: "once",
          atTime,
          timezone,
          nextRunAt: atTime,
          ...timestamps,
        },
      },
    };
  }

  if (request.kind === "loop") {
    return {
      kind: "ok",
      insert: {
        values: {
          kind: "loop",
          intervalSeconds: request.intervalSeconds,
          nextRunAt: args.automationEnabled ? currentTime : null,
          ...timestamps,
        },
      },
    };
  }

  const webhookToken = mintWebhookToken();
  const secret = mintWebhookSecret();
  const encryptedSecret = await encryptStoredSecretValue(secret);
  return {
    kind: "ok",
    insert: {
      values: { kind: "webhook", webhookToken, encryptedSecret, ...timestamps },
      webhookSecret: secret,
    },
  };
}

interface CreateAutomationBody {
  readonly name: string;
  readonly agentId: string;
  readonly instruction: string;
  readonly description?: string;
  readonly appendSystemPrompt?: string;
  readonly enabled?: boolean;
  readonly chatThreadId?: string;
  readonly trigger?: CreateTriggerRequest;
}

type CreateAutomationResult =
  | {
      readonly kind: "ok";
      readonly view: AutomationView;
      readonly webhookSecret?: string;
    }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "bad_request"; readonly message: string };

async function isNameTaken(
  db: Db,
  args: {
    readonly agentId: string;
    readonly name: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.agentId, args.agentId),
        eq(automations.name, args.name),
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// The create transaction: link the supplied owned chat thread or create one
// titled description ?? name, insert the automation (default interpreter,
// D1), and insert the optional first-trigger sugar row.
async function insertAutomationWithTrigger(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly body: CreateAutomationBody;
    readonly displayName: string | null;
    readonly enabled: boolean;
    readonly currentTime: Date;
    readonly triggerInsert: ResolvedTriggerInsert | null;
  },
): Promise<AutomationView> {
  const { body, currentTime } = args;
  return await db.transaction(async (tx): Promise<AutomationView> => {
    let chatThreadId = body.chatThreadId;
    if (chatThreadId === undefined) {
      const [thread] = await tx
        .insert(chatThreads)
        .values({
          userId: args.userId,
          agentComposeId: body.agentId,
          title: body.description ?? body.name,
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
        name: body.name,
        description: body.description ?? null,
        instruction: body.instruction,
        appendSystemPrompt: body.appendSystemPrompt ?? null,
        agentId: body.agentId,
        chatThreadId,
        interpreterKind: DEFAULT_INTERPRETER_KIND,
        enabled: args.enabled,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning();
    if (!automation) {
      throw new Error(`Failed to create automation ${body.name}`);
    }

    const triggers: AutomationTriggerRow[] = [];
    if (args.triggerInsert) {
      const [trigger] = await tx
        .insert(automationTriggers)
        .values({ automationId: automation.id, ...args.triggerInsert.values })
        .returning();
      if (!trigger) {
        throw new Error(`Failed to create trigger for ${body.name}`);
      }
      triggers.push(trigger);
    }

    return { automation, displayName: args.displayName, triggers };
  });
}

/**
 * Create an automation (optionally with its first trigger): validate the
 * target agent through the same visibility gate the automation deploy uses,
 * enforce the (agent, name, org, user) unique key up front, resolve the
 * chat-thread link (an owned existing thread or a server-created one — the
 * link is create-only), and persist the automation plus the optional sugar
 * trigger in one transaction. A webhook sugar trigger's signing secret is
 * returned exactly once. A write `command`.
 */
export const createAutomation$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly body: CreateAutomationBody;
    },
    signal: AbortSignal,
  ): Promise<CreateAutomationResult> => {
    const db = set(writeDb$);
    const { body } = args;

    const agent = await loadAgentForDeploy(db, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: body.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "not_found", message: "Agent not found" };
    }

    if (body.chatThreadId !== undefined) {
      const linkable = await isChatThreadLinkable(db, {
        chatThreadId: body.chatThreadId,
        userId: args.userId,
        agentId: body.agentId,
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

    const nameTaken = await isNameTaken(db, {
      agentId: body.agentId,
      name: body.name,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    if (nameTaken) {
      return {
        kind: "bad_request",
        message: `Automation ${body.name} already exists on this agent`,
      };
    }

    const enabled = body.enabled ?? true;
    const currentTime = nowDate();
    let triggerInsert: ResolvedTriggerInsert | null = null;
    if (body.trigger) {
      const resolved = await resolveTriggerInsert({
        request: body.trigger,
        automationEnabled: enabled,
        currentTime,
      });
      signal.throwIfAborted();
      if (resolved.kind === "bad_request") {
        return resolved;
      }
      triggerInsert = resolved.insert;
    }

    // Parity with the legacy deploy behavior: an omitted description is
    // generated (LLM with template fallback) so list views are never blank.
    const effectiveBody =
      body.description === undefined
        ? {
            ...body,
            description: await generateAutomationDescription(
              {
                name: body.name,
                instruction: body.instruction,
                ...(body.trigger?.kind === "cron" && {
                  cronExpression: body.trigger.cronExpression,
                }),
                ...(body.trigger?.kind === "once" && {
                  atTime: body.trigger.atTime,
                }),
                ...(body.trigger?.kind === "loop" && {
                  intervalSeconds: body.trigger.intervalSeconds,
                }),
              },
              agent.name,
            ),
          }
        : body;
    signal.throwIfAborted();

    const view = await insertAutomationWithTrigger(db, {
      userId: args.userId,
      orgId: args.orgId,
      body: effectiveBody,
      displayName: agent.displayName,
      enabled,
      currentTime,
      triggerInsert,
    });
    signal.throwIfAborted();

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      view.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      view,
      ...(triggerInsert?.webhookSecret !== undefined
        ? { webhookSecret: triggerInsert.webhookSecret }
        : {}),
    };
  },
);

/**
 * List the caller's automations (every interpreter kind — this is the unified
 * surface) with ALL their triggers, scoped to (orgId, userId), newest first.
 */
export const listAutomations$ = command(
  async (
    { set },
    args: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<readonly AutomationView[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({ automation: automations, displayName: zeroAgents.displayName })
      .from(automations)
      .leftJoin(zeroAgents, eq(zeroAgents.id, automations.agentId))
      .where(
        and(
          eq(automations.orgId, args.orgId),
          eq(automations.userId, args.userId),
        ),
      )
      .orderBy(desc(automations.createdAt));
    signal.throwIfAborted();
    if (rows.length === 0) {
      return [];
    }

    const triggerRows = await db
      .select()
      .from(automationTriggers)
      .where(
        inArray(
          automationTriggers.automationId,
          rows.map((row) => {
            return row.automation.id;
          }),
        ),
      )
      .orderBy(asc(automationTriggers.createdAt), asc(automationTriggers.id));
    signal.throwIfAborted();

    const triggersByAutomation = new Map<string, AutomationTriggerRow[]>();
    for (const trigger of triggerRows) {
      const list = triggersByAutomation.get(trigger.automationId) ?? [];
      list.push(trigger);
      triggersByAutomation.set(trigger.automationId, list);
    }

    return rows.map((row) => {
      return {
        automation: row.automation,
        displayName: row.displayName ?? null,
        triggers: triggersByAutomation.get(row.automation.id) ?? [],
      };
    });
  },
);

type AutomationResult =
  | { readonly kind: "ok"; readonly view: AutomationView }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "bad_request"; readonly message: string };

/** Show an automation (by id or unique name) with all its triggers. */
export const showAutomation$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly ref: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const resolved = await resolveAutomationRef(db, args);
    signal.throwIfAborted();
    if (resolved.kind !== "ok") {
      return resolved;
    }
    const triggers = await loadTriggers(db, resolved.automation.id);
    signal.throwIfAborted();
    return {
      kind: "ok",
      view: {
        automation: resolved.automation,
        displayName: resolved.displayName,
        triggers,
      },
    };
  },
);

interface UpdateAutomationBody {
  readonly name?: string;
  readonly instruction?: string;
  readonly description?: string | null;
  readonly appendSystemPrompt?: string | null;
}

/**
 * Update an automation's identity/intent fields. `agentId` is immutable (the
 * linked chat thread is bound to the agent) and the trigger config lives on
 * the trigger endpoints. Renaming re-checks the (agent, name, org, user)
 * unique key; null clears the nullable fields.
 */
export const updateAutomation$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly ref: string;
      readonly body: UpdateAutomationBody;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const resolved = await resolveAutomationRef(db, args);
    signal.throwIfAborted();
    if (resolved.kind !== "ok") {
      return resolved;
    }
    const { automation } = resolved;
    const { body } = args;

    if (body.name !== undefined && body.name !== automation.name) {
      const nameTaken = await isNameTaken(db, {
        agentId: automation.agentId,
        name: body.name,
        orgId: args.orgId,
        userId: args.userId,
      });
      signal.throwIfAborted();
      if (nameTaken) {
        return {
          kind: "bad_request",
          message: `Automation ${body.name} already exists on this agent`,
        };
      }
    }

    const [updated] = await db
      .update(automations)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.instruction !== undefined
          ? { instruction: body.instruction }
          : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: body.appendSystemPrompt }
          : {}),
        updatedAt: nowDate(),
      })
      .where(eq(automations.id, automation.id))
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    const triggers = await loadTriggers(db, updated.id);
    signal.throwIfAborted();

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      updated.chatThreadId,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      view: {
        automation: updated,
        displayName: resolved.displayName,
        triggers,
      },
    };
  },
);

type DeleteAutomationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" };

/** Delete an automation; its trigger rows are removed by the FK cascade. */
export const deleteAutomation$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly ref: string;
    },
    signal: AbortSignal,
  ): Promise<DeleteAutomationResult> => {
    const db = set(writeDb$);
    const resolved = await resolveAutomationRef(db, args);
    signal.throwIfAborted();
    if (resolved.kind !== "ok") {
      return resolved;
    }
    const chatThreadId = resolved.automation.chatThreadId;

    await db
      .delete(automations)
      .where(eq(automations.id, resolved.automation.id));
    signal.throwIfAborted();

    await publishChatThreadAutomationsChangedSafely(args.userId, chatThreadId);
    signal.throwIfAborted();

    return { kind: "ok" };
  },
);

type TimeTriggerRecompute =
  | { readonly kind: "ok"; readonly nextRunAt: Date | null }
  | { readonly kind: "expired" };

/**
 * Next run for a time trigger being (re-)enabled — the same rules trigger
 * creation applies, so a long-disabled automation resumes without a catch-up
 * storm: a cron schedules its next occurrence (only while the automation is
 * enabled), a one-time fire keeps its instant if still in the future and is
 * expired otherwise, and a loop is due immediately.
 */
function recomputeTimeTriggerNextRun(
  trigger: AutomationTriggerRow,
  automationEnabled: boolean,
  currentTime: Date,
): TimeTriggerRecompute {
  if (trigger.kind === "cron" && trigger.cronExpression !== null) {
    return {
      kind: "ok",
      nextRunAt: automationEnabled
        ? calculateNextRun(
            trigger.cronExpression,
            trigger.timezone,
            currentTime,
          )
        : null,
    };
  }
  if (trigger.kind === "once") {
    if (trigger.atTime !== null && trigger.atTime > currentTime) {
      return { kind: "ok", nextRunAt: trigger.atTime };
    }
    return { kind: "expired" };
  }
  if (trigger.kind === "loop") {
    return { kind: "ok", nextRunAt: currentTime };
  }
  throw new Error(`Not a time trigger: ${trigger.kind}`);
}

function isTimeTriggerKind(kind: string): boolean {
  return (TIME_TRIGGER_KINDS as readonly string[]).includes(kind);
}

/**
 * Enable or disable an automation. Enabling recomputes `nextRunAt` for each
 * still-enabled time trigger (an expired one-time trigger is disabled instead)
 * so resumed automations fire on their next occurrence rather than catching up.
 * Disabling clears `nextRunAt` on every time trigger (without touching their
 * own enabled flag, lastRunId, or failure counter) so the poller stops seeing
 * them: a loop trigger is always due by design, so a disabled automation that
 * left its rows scheduled would sit permanently due and starve the poller batch
 * (#17546). Re-enabling recomputes the next run. The inbound webhook dispatch
 * still also checks `automation.enabled && trigger.enabled`.
 */
export const setAutomationEnabled$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly ref: string;
      readonly enabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const resolved = await resolveAutomationRef(db, args);
    signal.throwIfAborted();
    if (resolved.kind !== "ok") {
      return resolved;
    }
    const currentTime = nowDate();

    const automation = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(automations)
        .set({ enabled: args.enabled, updatedAt: currentTime })
        .where(eq(automations.id, resolved.automation.id))
        .returning();
      if (!updated) {
        throw new Error(`Failed to update automation ${args.ref}`);
      }

      if (args.enabled) {
        const triggers = await tx
          .select()
          .from(automationTriggers)
          .where(eq(automationTriggers.automationId, updated.id));
        for (const trigger of triggers) {
          if (!trigger.enabled || !isTimeTriggerKind(trigger.kind)) {
            continue;
          }
          const recompute = recomputeTimeTriggerNextRun(
            trigger,
            true,
            currentTime,
          );
          await tx
            .update(automationTriggers)
            .set(
              recompute.kind === "ok"
                ? {
                    nextRunAt: recompute.nextRunAt,
                    consecutiveFailures: 0,
                    updatedAt: currentTime,
                  }
                : // An expired one-time trigger cannot fire again: disable it
                  // instead of resurrecting a past instant.
                  { enabled: false, nextRunAt: null, updatedAt: currentTime },
            )
            .where(eq(automationTriggers.id, trigger.id));
        }
      } else {
        // Clear the next run on every scheduled time trigger so the poller
        // stops seeing them: a loop trigger is always due by design, so leaving
        // a disabled automation's rows scheduled creates a permanently-due
        // "zombie" that fills the poller batch and starves real work (#17546).
        // The trigger's own enabled flag / lastRunId / failure counter stay
        // intact; re-enabling recomputes the next run.
        await tx
          .update(automationTriggers)
          .set({ nextRunAt: null, updatedAt: currentTime })
          .where(
            and(
              eq(automationTriggers.automationId, updated.id),
              inArray(automationTriggers.kind, [...TIME_TRIGGER_KINDS]),
              isNotNull(automationTriggers.nextRunAt),
            ),
          );
      }

      return updated;
    });
    signal.throwIfAborted();

    const triggers = await loadTriggers(db, automation.id);
    signal.throwIfAborted();

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      automation.chatThreadId,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      view: { automation, displayName: resolved.displayName, triggers },
    };
  },
);

type TriggerMutationResult =
  | {
      readonly kind: "ok";
      readonly trigger: AutomationTriggerRow;
      readonly webhookSecret?: string;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "bad_request"; readonly message: string };

/**
 * Add a trigger to an automation (the same resolution backing the create-time
 * sugar). Multiple triggers of the same kind are allowed; a webhook trigger's
 * signing secret is returned exactly once.
 */
export const addTrigger$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly ref: string;
      readonly request: CreateTriggerRequest;
    },
    signal: AbortSignal,
  ): Promise<TriggerMutationResult> => {
    const db = set(writeDb$);
    const resolved = await resolveAutomationRef(db, args);
    signal.throwIfAborted();
    if (resolved.kind !== "ok") {
      return resolved;
    }

    const result = await resolveTriggerInsert({
      request: args.request,
      automationEnabled: resolved.automation.enabled,
      currentTime: nowDate(),
    });
    signal.throwIfAborted();
    if (result.kind === "bad_request") {
      return result;
    }

    const [trigger] = await db
      .insert(automationTriggers)
      .values({
        automationId: resolved.automation.id,
        ...result.insert.values,
      })
      .returning();
    signal.throwIfAborted();
    if (!trigger) {
      throw new Error(`Failed to create trigger for ${args.ref}`);
    }

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      resolved.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      trigger,
      ...(result.insert.webhookSecret !== undefined
        ? { webhookSecret: result.insert.webhookSecret }
        : {}),
    };
  },
);

interface TriggerOwnership {
  readonly trigger: AutomationTriggerRow;
  readonly automation: AutomationRow;
}

/** Load a trigger joined with its automation, scoped to the caller. */
async function loadOwnedTrigger(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly id: string;
  },
): Promise<TriggerOwnership | null> {
  const [row] = await db
    .select({ trigger: automationTriggers, automation: automations })
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .where(
      and(
        eq(automationTriggers.id, args.id),
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

type ShowTriggerResult =
  | { readonly kind: "ok"; readonly trigger: AutomationTriggerRow }
  | { readonly kind: "not_found" };

/** Show a single trigger by id, scoped to the caller. */
export const showTrigger$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<ShowTriggerResult> => {
    const db = set(writeDb$);
    const owned = await loadOwnedTrigger(db, args);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "not_found" };
    }
    return { kind: "ok", trigger: owned.trigger };
  },
);

type RemoveTriggerResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" };

/** Remove a single trigger; the automation itself is untouched. */
export const removeTrigger$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<RemoveTriggerResult> => {
    const db = set(writeDb$);
    const owned = await loadOwnedTrigger(db, args);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "not_found" };
    }

    await db
      .delete(automationTriggers)
      .where(eq(automationTriggers.id, owned.trigger.id));
    signal.throwIfAborted();

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      owned.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return { kind: "ok" };
  },
);

/**
 * Enable or disable a single trigger. Enabling a time trigger recomputes its
 * `nextRunAt` (an expired one-time trigger is rejected); disabling leaves the
 * row's time state as-is — the poller and the inbound dispatch skip via the
 * enabled flags.
 */
export const setTriggerEnabled$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly id: string;
      readonly enabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<TriggerMutationResult> => {
    const db = set(writeDb$);
    const owned = await loadOwnedTrigger(db, args);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "not_found" };
    }
    const currentTime = nowDate();

    let recomputedState: {
      readonly nextRunAt: Date | null;
      readonly consecutiveFailures: number;
    } | null = null;
    if (args.enabled && isTimeTriggerKind(owned.trigger.kind)) {
      const recompute = recomputeTimeTriggerNextRun(
        owned.trigger,
        owned.automation.enabled,
        currentTime,
      );
      if (recompute.kind === "expired") {
        return {
          kind: "bad_request",
          message: "Cannot enable the automation: time has already passed",
        };
      }
      recomputedState = {
        nextRunAt: recompute.nextRunAt,
        consecutiveFailures: 0,
      };
    }

    const [trigger] = await db
      .update(automationTriggers)
      .set({
        enabled: args.enabled,
        ...recomputedState,
        updatedAt: currentTime,
      })
      .where(eq(automationTriggers.id, owned.trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!trigger) {
      return { kind: "not_found" };
    }

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      owned.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return { kind: "ok", trigger };
  },
);

/**
 * Replace a time trigger's schedule config in place — the kind may switch
 * among cron/once/loop. The row keeps its id, enabled flag, and lastRunId
 * history; `nextRunAt` is recomputed by the creation rules (a cron schedules
 * only while the automation is enabled) and the consecutive-failure counter
 * resets — the same revive semantics as enable. Webhook triggers carry no
 * schedule and are rejected.
 */
export const updateTrigger$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly id: string;
      readonly body: UpdateTriggerRequest;
    },
    signal: AbortSignal,
  ): Promise<TriggerMutationResult> => {
    const db = set(writeDb$);
    const owned = await loadOwnedTrigger(db, args);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "not_found" };
    }
    if (owned.trigger.kind === "webhook") {
      return {
        kind: "bad_request",
        message: "Webhook triggers have no schedule to update",
      };
    }

    const currentTime = nowDate();
    const result = await resolveTriggerInsert({
      request: args.body,
      automationEnabled: owned.automation.enabled,
      currentTime,
    });
    signal.throwIfAborted();
    if (result.kind === "bad_request") {
      return result;
    }
    const { values } = result.insert;

    // The B4 CHECK constraint requires each kind to carry exactly its own
    // config columns, so the new kind's fields are set and the unused ones
    // are nulled explicitly (the timezone column is NOT NULL, default UTC —
    // the same effective value a fresh loop insert gets). The enabled flag,
    // lastRunId, and the webhook columns are untouched.
    const [trigger] = await db
      .update(automationTriggers)
      .set({
        kind: values.kind,
        cronExpression: values.cronExpression ?? null,
        atTime: values.atTime ?? null,
        intervalSeconds: values.intervalSeconds ?? null,
        timezone: values.timezone ?? "UTC",
        nextRunAt: values.nextRunAt,
        consecutiveFailures: 0,
        updatedAt: currentTime,
      })
      .where(eq(automationTriggers.id, owned.trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!trigger) {
      return { kind: "not_found" };
    }

    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      owned.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return { kind: "ok", trigger };
  },
);

/**
 * Rotate a webhook trigger's HMAC signing secret: mint a fresh secret, store
 * it encrypted, and return it exactly once. The URL token (identity) is
 * unchanged. Rejected for non-webhook triggers.
 */
export const rotateTriggerSecret$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<TriggerMutationResult> => {
    const db = set(writeDb$);
    const owned = await loadOwnedTrigger(db, args);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "not_found" };
    }
    if (owned.trigger.kind !== "webhook") {
      return {
        kind: "bad_request",
        message: "Only webhook triggers carry a signing secret",
      };
    }

    const secret = mintWebhookSecret();
    const encryptedSecret = await encryptStoredSecretValue(secret);
    signal.throwIfAborted();

    const [trigger] = await db
      .update(automationTriggers)
      .set({ encryptedSecret, updatedAt: nowDate() })
      .where(eq(automationTriggers.id, owned.trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!trigger) {
      return { kind: "not_found" };
    }

    return { kind: "ok", trigger, webhookSecret: secret };
  },
);

type RunAutomationResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunCreationErrorResponse };

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

/**
 * Manually fire an automation as a web-chat turn in its linked thread:
 * instruction-only, no event payload. No trigger row is claimed, so the run
 * carries only the chat callback (nothing to reschedule) and automation-only
 * provenance. The fire conflicts (409) while any of the automation's triggers
 * has an active last run — the same per-trigger skip-if-active rule the
 * poller applies; a triggerless automation has nothing to conflict with.
 */
export const runAutomationNow$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly ref: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<RunAutomationResult> => {
    const db = set(writeDb$);
    const resolved = await resolveAutomationRef(db, args);
    signal.throwIfAborted();
    if (resolved.kind !== "ok") {
      return resolved;
    }
    const { automation } = resolved;

    const triggers = await loadTriggers(db, automation.id);
    signal.throwIfAborted();
    const lastRunIds = triggers.flatMap((trigger) => {
      return trigger.lastRunId === null ? [] : [trigger.lastRunId];
    });
    if (lastRunIds.length > 0) {
      const lastRuns = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(inArray(agentRuns.id, lastRunIds));
      signal.throwIfAborted();
      if (
        lastRuns.some((run) => {
          return isActivePreviousRunStatus(run.status);
        })
      ) {
        return { kind: "conflict", message: "Previous run is still active" };
      }
    }

    const modelContext = await resolveAutomationRunModelContext({
      db,
      orgId: automation.orgId,
      userId: automation.userId,
      chatThreadId: automation.chatThreadId,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    const runInput = await new DefaultInterpreter().interpret(
      automationRowToManualAutomation({
        id: automation.id,
        agentId: automation.agentId,
        orgId: automation.orgId,
        userId: automation.userId,
        chatThreadId: automation.chatThreadId,
        instruction: automation.instruction,
        appendSystemPrompt: automation.appendSystemPrompt,
      }),
      { kind: "manual" },
    );
    signal.throwIfAborted();

    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: automation.orgId,
          orgRole: "member",
          userId: automation.userId,
          tokenType: "session",
        },
        body: {
          prompt: runInput.prompt,
          agentId: runInput.agentId,
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "automation",
        chatThreadId: runInput.chatThreadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await persistManualRunSideEffects({
      db,
      automation,
      runId: result.body.runId,
      queued: result.body.status === "queued",
      prompt: runInput.prompt,
      modelPin,
      effectiveModelProvider,
    });
    signal.throwIfAborted();

    return { kind: "ok", runId: result.body.runId };
  },
);
