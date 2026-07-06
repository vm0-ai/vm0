import { command } from "ccstate";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";

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

/**
 * List the caller's automations (every interpreter kind — this is the unified
 * surface) with their schedule trigger, scoped to (orgId, userId), newest first.
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
  | { readonly kind: "ambiguous" };

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
    const [row] = await db
      .select({ trigger: automationTriggers })
      .from(automationTriggers)
      .innerJoin(
        automations,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(
        and(
          eq(automationTriggers.id, args.id),
          eq(automations.orgId, args.orgId),
          eq(automations.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found" };
    }
    return { kind: "ok", trigger: row.trigger };
  },
);
