import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testUsageInsightStateContract,
  type TestUsageInsightStateActionBody,
} from "@vm0/api-contracts/contracts/test-usage-insight-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  browserProfiles,
  browserSessionInstances,
  browserSessions,
} from "@vm0/db/schema/browser-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@vm0/db/schema/org-usage-allowance";
import { secrets } from "@vm0/db/schema/secret";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usageEventHourlyRollup } from "@vm0/db/schema/usage-event-hourly-rollup";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { variables } from "@vm0/db/schema/variable";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  sum,
} from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  deleteOrgUsageData,
  deleteUserUsageData,
} from "../services/usage-event-cleanup.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testUsageInsightStateContract.action);

interface UsageInsightFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly triggerSource?: string;
  readonly chatThreadId?: string;
  readonly status?: string;
  readonly prompt?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly continuedFromSessionId?: string | null;
  readonly sandboxReuseResult?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly lastEventSequence?: number | null;
  readonly selectedModel?: string | null;
}

interface ModelUsageEventArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly creditsCharged?: number;
  readonly status?: string;
  readonly processedAt?: Date | null;
}

type UsageInsightAction<
  Action extends TestUsageInsightStateActionBody["action"],
> = Extract<TestUsageInsightStateActionBody, { readonly action: Action }>;

type UsageInsightFixtureAction = UsageInsightAction<
  "seed-fixture" | "delete-fixture" | "seed-compose"
>;

type UsageInsightRunAction = UsageInsightAction<
  "seed-run" | "seed-chat-thread"
>;

type UsageInsightEventWriteAction = UsageInsightAction<
  | "insert-model-usage-event-for-run"
  | "insert-usage-event"
  | "set-browser-usage-hold"
  | "attach-usage-allowance"
  | "read-allowance-window-state"
>;

type UsageInsightEventMaterializationAction = UsageInsightAction<
  | "delete-run"
  | "seed-usage-overflow-grain"
  | "set-usage-event-created-at"
  | "materialize-hourly-usage"
  | "read-usage-storage-counts"
>;

type UsageInsightCleanupAction = UsageInsightAction<"delete-usage-data">;

const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return new Date(value);
}

function parseMaybeDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(value);
}

function fixtureToWire(fixture: UsageInsightFixture) {
  return { org_id: fixture.orgId, user_id: fixture.userId };
}

function fixtureFromWire(fixture: {
  readonly org_id: string;
  readonly user_id: string;
}): UsageInsightFixture {
  return { orgId: fixture.org_id, userId: fixture.user_id };
}

async function seedUsageInsightFixture(db: Db): Promise<UsageInsightFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  await db.insert(orgMetadata).values({
    orgId: fixture.orgId,
    tier: "free",
    credits: 10_000,
  });
  return fixture;
}

async function deleteUsageInsightFixtureUsageData(
  db: Db,
  fixture: UsageInsightFixture,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(browserSessions)
    .where(
      and(
        eq(browserSessions.orgId, fixture.orgId),
        eq(browserSessions.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, fixture.orgId),
        eq(browserProfiles.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(usageEventHourlyRollup)
    .where(
      and(
        eq(usageEventHourlyRollup.orgId, fixture.orgId),
        eq(usageEventHourlyRollup.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, fixture.orgId),
        eq(usageEvent.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, fixture.orgId));
  signal.throwIfAborted();
}

async function deleteUsageInsightFixture(
  db: Db,
  fixture: UsageInsightFixture,
  signal: AbortSignal,
): Promise<void> {
  const orgId = fixture.orgId;
  const userId = fixture.userId;

  await deleteUsageInsightFixtureUsageData(db, fixture, signal);

  await db
    .delete(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, orgId),
        eq(userPermissionGrants.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(userConnectors)
    .where(
      and(eq(userConnectors.orgId, orgId), eq(userConnectors.userId, userId)),
    );
  signal.throwIfAborted();

  await db
    .delete(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)));
  signal.throwIfAborted();

  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  signal.throwIfAborted();

  await db.delete(variables).where(eq(variables.orgId, orgId));
  signal.throwIfAborted();

  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();

  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.userId, userId)));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    signal.throwIfAborted();
  }

  if (runIds.length > 0) {
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  await db
    .delete(agentSessions)
    .where(
      and(eq(agentSessions.orgId, orgId), eq(agentSessions.userId, userId)),
    );
  signal.throwIfAborted();

  const composeRows = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(eq(agentComposes.orgId, orgId), eq(agentComposes.userId, userId)),
    );
  signal.throwIfAborted();
  const composeIds = composeRows.map((row) => {
    return row.id;
  });
  if (composeIds.length > 0) {
    await db
      .delete(agentComposeVersions)
      .where(inArray(agentComposeVersions.composeId, composeIds));
    signal.throwIfAborted();
  }

  await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
  signal.throwIfAborted();

  if (composeIds.length > 0) {
    await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
    signal.throwIfAborted();
  }

  await db
    .delete(agentComposes)
    .where(
      and(eq(agentComposes.orgId, orgId), eq(agentComposes.userId, userId)),
    );
  signal.throwIfAborted();

  const storageRows = await db
    .select({ id: storages.id })
    .from(storages)
    .where(eq(storages.orgId, orgId));
  signal.throwIfAborted();
  const storageIds = storageRows.map((row) => {
    return row.id;
  });
  if (storageIds.length > 0) {
    await db
      .update(storages)
      .set({ headVersionId: null })
      .where(inArray(storages.id, storageIds));
    signal.throwIfAborted();
    await db
      .delete(storageVersions)
      .where(inArray(storageVersions.storageId, storageIds));
    signal.throwIfAborted();
    await db.delete(storages).where(eq(storages.orgId, orgId));
    signal.throwIfAborted();
  }
}

async function seedCompose(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name?: string;
    readonly displayName?: string | null;
    readonly visibility?: "public" | "private";
  },
): Promise<{ composeId: string; agentId: string }> {
  const name = args.name ?? `compose-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(agentComposes)
    .values({ userId: args.userId, orgId: args.orgId, name })
    .returning({ id: agentComposes.id });
  if (!row) {
    throw new Error("seedCompose: insert returned no row");
  }
  await db
    .insert(zeroAgents)
    .values({
      id: row.id,
      orgId: args.orgId,
      owner: args.userId,
      name,
      displayName: args.displayName ?? null,
      visibility: args.visibility ?? "public",
    })
    .onConflictDoNothing();
  return { composeId: row.id, agentId: row.id };
}

async function seedRun(
  db: Db,
  args: SeedRunArgs,
  signal: AbortSignal,
): Promise<{ runId: string }> {
  const versionId = randomUUID();
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: args.composeId,
    content: {
      version: "1.0",
      agents: { "test-agent": { framework: "claude-code" } },
    },
    createdBy: args.userId,
  });
  signal.throwIfAborted();
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, args.composeId));
  signal.throwIfAborted();
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeId: args.composeId,
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    throw new Error("seedRun: session insert returned no row");
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeVersionId: versionId,
      prompt: args.prompt ?? "test prompt",
      status: args.status ?? "pending",
      sessionId: session.id,
      createdAt: args.createdAt,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      continuedFromSessionId: args.continuedFromSessionId,
      sandboxReuseResult: args.sandboxReuseResult ?? null,
      result: args.result ?? null,
      error: args.error ?? null,
      lastEventSequence: args.lastEventSequence ?? null,
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    throw new Error("seedRun: run insert returned no row");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: args.triggerSource ?? "cli",
    chatThreadId: args.chatThreadId ?? null,
    selectedModel: args.selectedModel ?? null,
  });
  signal.throwIfAborted();
  return { runId: run.id };
}

async function seedChatThread(
  db: Db,
  args: {
    readonly userId: string;
    readonly composeId: string;
    readonly title?: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const [row] = await db
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.composeId,
      title: args.title ?? null,
    })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!row) {
    throw new Error("seedChatThread: insert returned no row");
  }
  return row.id;
}

interface ModelRowQuantity {
  readonly category: (typeof MODEL_TOKEN_CATEGORIES)[number];
  readonly quantity: number;
}

function buildModelUsageRows(args: ModelUsageEventArgs): {
  rows: (typeof usageEvent.$inferInsert)[];
} {
  const status = args.status ?? "pending";
  const createdAt = nowDate();
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? createdAt
        : null;
  const provider = "claude-sonnet-4-6";
  const quantities: readonly ModelRowQuantity[] = [
    { category: "tokens.input", quantity: args.inputTokens ?? 0 },
    { category: "tokens.output", quantity: args.outputTokens ?? 0 },
    { category: "tokens.cache_read", quantity: args.cacheReadInputTokens ?? 0 },
    {
      category: "tokens.cache_creation",
      quantity: args.cacheCreationInputTokens ?? 0,
    },
  ];
  const billable = quantities.filter((entry, index) => {
    return index === 0 || entry.quantity > 0;
  });
  const rows = billable.map((entry, index) => {
    return {
      runId: args.runId,
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider,
      category: entry.category,
      quantity: entry.quantity,
      creditsCharged: index === 0 ? (args.creditsCharged ?? null) : null,
      status,
      idempotencyKey: randomUUID(),
      createdAt,
      processedAt,
    };
  });
  return { rows };
}

async function insertModelUsageEventForRun(
  db: Db,
  args: ModelUsageEventArgs,
): Promise<{ id: string }> {
  const { rows } = buildModelUsageRows({
    ...args,
    inputTokens: args.inputTokens ?? 100,
    outputTokens: args.outputTokens ?? 50,
  });
  const [row] = await db
    .insert(usageEvent)
    .values(rows)
    .returning({ id: usageEvent.id });
  if (!row) {
    throw new Error("insertModelUsageEventForRun: returned no row");
  }
  return { id: row.id };
}

async function insertUsageEvent(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId?: string;
    readonly runId?: string | null;
    readonly kind?: string;
    readonly provider?: string;
    readonly category?: string;
    readonly quantity?: number;
    readonly status?: string;
    readonly creditsCharged?: number;
    readonly idempotencyKey?: string;
    readonly billingError?: string | null;
    readonly createdAt?: Date;
    readonly processedAt?: Date | null;
    readonly count?: number;
  },
): Promise<string> {
  const status = args.status ?? "pending";
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? nowDate()
        : null;
  const count = args.count ?? 1;
  const values: (typeof usageEvent.$inferInsert)[] = Array.from(
    { length: count },
    () => {
      return {
        runId: args.runId ?? null,
        orgId: args.orgId,
        userId: args.userId ?? "test-user",
        kind: args.kind ?? "connector",
        provider: args.provider ?? "x",
        category: args.category ?? "tweet.read",
        quantity: args.quantity ?? 1,
        status,
        creditsCharged: args.creditsCharged ?? null,
        billingError: args.billingError ?? null,
        idempotencyKey: args.idempotencyKey ?? randomUUID(),
        createdAt: args.createdAt ?? nowDate(),
        processedAt,
      };
    },
  );
  const rows = await db
    .insert(usageEvent)
    .values(values)
    .returning({ id: usageEvent.id });
  const row = rows[0];
  if (!row) {
    throw new Error("insertUsageEvent: insert returned no row");
  }
  return row.id;
}

async function setBrowserUsageHold(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
    readonly chatThreadId: string;
    readonly idempotencyKey: string;
    readonly settled: boolean;
  },
): Promise<void> {
  const [existing] = await db
    .select({
      providerSessionId: browserSessionInstances.providerSessionId,
    })
    .from(browserSessionInstances)
    .where(eq(browserSessionInstances.providerSessionId, args.idempotencyKey))
    .limit(1);
  if (existing) {
    await db
      .update(browserSessionInstances)
      .set({ settledAt: args.settled ? nowDate() : null })
      .where(
        eq(browserSessionInstances.providerSessionId, args.idempotencyKey),
      );
    return;
  }

  let [profile] = await db
    .select({ id: browserProfiles.id })
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, args.orgId),
        eq(browserProfiles.userId, args.userId),
      ),
    )
    .limit(1);
  if (!profile) {
    [profile] = await db
      .insert(browserProfiles)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        providerProfileId: randomUUID(),
      })
      .returning({ id: browserProfiles.id });
  }
  if (!profile) {
    throw new Error("setBrowserUsageHold: profile insert returned no row");
  }

  const [browser] = await db
    .insert(browserSessions)
    .values({
      chatThreadId: args.chatThreadId,
      runId: args.runId,
      orgId: args.orgId,
      userId: args.userId,
      name: "Compaction hold fixture",
      browserProfileId: profile.id,
      status: "suspended",
      timeoutMinutes: 10,
      maxCredits: 100,
    })
    .returning({ id: browserSessions.id });
  if (!browser) {
    throw new Error("setBrowserUsageHold: browser insert returned no row");
  }

  const now = nowDate();
  await db.insert(browserSessionInstances).values({
    providerSessionId: args.idempotencyKey,
    browserSessionId: browser.id,
    chatThreadId: args.chatThreadId,
    runId: args.runId,
    status: "stopped",
    pricingUnitPrice: 1,
    pricingUnitSize: 1,
    timeoutAt: new Date(now.getTime() + 60_000),
    startedAt: now,
    finishedAt: now,
    settledAt: args.settled ? now : null,
  });
}

async function attachUsageAllowance(
  db: Db,
  args: {
    readonly orgId: string;
    readonly runId: string | null;
    readonly usageEventId: string;
    readonly unitsApplied: number;
    readonly consumedUnits: number;
  },
): Promise<{
  readonly shortWindowId: string;
  readonly weeklyWindowId: string;
}> {
  let [entitlement] = await db
    .select({ id: orgUsageAllowanceEntitlements.id })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, args.orgId))
    .limit(1);
  if (!entitlement) {
    [entitlement] = await db
      .insert(orgUsageAllowanceEntitlements)
      .values({
        orgId: args.orgId,
        shortWindowSeconds: 3600,
        shortWindowUnits: 1_000_000,
        weeklyWindowUnits: 1_000_000,
        effectiveAt: new Date("2000-01-01T00:00:00.000Z"),
      })
      .returning({ id: orgUsageAllowanceEntitlements.id });
  }
  if (!entitlement) {
    throw new Error("attachUsageAllowance: entitlement insert returned no row");
  }

  const windowLimit = Math.max(args.consumedUnits, args.unitsApplied) + 100;
  const windows = await db
    .insert(orgUsageAllowanceWindows)
    .values([
      {
        orgId: args.orgId,
        entitlementId: entitlement.id,
        kind: "short",
        startsAt: new Date("2000-01-01T00:00:00.000Z"),
        expiresAt: new Date("3000-01-01T00:00:00.000Z"),
        unitLimit: windowLimit,
        consumedUnits: args.consumedUnits,
        createdByRunId: args.runId,
      },
      {
        orgId: args.orgId,
        entitlementId: entitlement.id,
        kind: "weekly",
        startsAt: new Date("2000-01-01T00:00:00.000Z"),
        expiresAt: new Date("3000-01-01T00:00:00.000Z"),
        unitLimit: windowLimit,
        consumedUnits: args.consumedUnits,
        createdByRunId: args.runId,
      },
    ])
    .returning({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
    });
  const shortWindow = windows.find((window) => {
    return window.kind === "short";
  });
  const weeklyWindow = windows.find((window) => {
    return window.kind === "weekly";
  });
  if (!shortWindow || !weeklyWindow) {
    throw new Error("attachUsageAllowance: window insert returned no pair");
  }

  await db.insert(usageAllowanceAllocations).values({
    usageEventId: args.usageEventId,
    orgId: args.orgId,
    runId: args.runId,
    shortWindowId: shortWindow.id,
    weeklyWindowId: weeklyWindow.id,
    unitsApplied: args.unitsApplied,
  });
  return {
    shortWindowId: shortWindow.id,
    weeklyWindowId: weeklyWindow.id,
  };
}

async function readAllowanceWindowState(
  db: Db,
  args: {
    readonly shortWindowId: string;
    readonly weeklyWindowId: string;
  },
) {
  const [[shortWindow], [weeklyWindow], [raw], [hourly]] = await Promise.all([
    db
      .select({ consumedUnits: orgUsageAllowanceWindows.consumedUnits })
      .from(orgUsageAllowanceWindows)
      .where(eq(orgUsageAllowanceWindows.id, args.shortWindowId))
      .limit(1),
    db
      .select({ consumedUnits: orgUsageAllowanceWindows.consumedUnits })
      .from(orgUsageAllowanceWindows)
      .where(eq(orgUsageAllowanceWindows.id, args.weeklyWindowId))
      .limit(1),
    db
      .select({
        allowanceUnits: sum(usageAllowanceAllocations.unitsApplied),
        allocationCount: count(),
      })
      .from(usageAllowanceAllocations)
      .where(
        and(
          eq(usageAllowanceAllocations.shortWindowId, args.shortWindowId),
          eq(usageAllowanceAllocations.weeklyWindowId, args.weeklyWindowId),
        ),
      ),
    db
      .select({
        allowanceUnits: sum(usageEventHourlyRollup.allowanceUnits),
      })
      .from(usageEventHourlyRollup)
      .where(
        and(
          eq(usageEventHourlyRollup.shortWindowId, args.shortWindowId),
          eq(usageEventHourlyRollup.weeklyWindowId, args.weeklyWindowId),
        ),
      ),
  ]);
  if (!shortWindow || !weeklyWindow) {
    throw new Error("readAllowanceWindowState: allowance window not found");
  }
  return {
    shortWindowConsumedUnits: String(shortWindow.consumedUnits),
    weeklyWindowConsumedUnits: String(weeklyWindow.consumedUnits),
    rawAllowanceUnits: raw?.allowanceUnits ?? "0",
    hourlyAllowanceUnits: hourly?.allowanceUnits ?? "0",
    allocationCount: raw?.allocationCount ?? 0,
  };
}

async function deleteRun(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(zeroRuns).where(eq(zeroRuns.id, runId));
  signal.throwIfAborted();
  await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  signal.throwIfAborted();
}

async function seedUsageOverflowGrain(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly processedAt: Date;
  },
): Promise<void> {
  const processedHour = new Date(args.processedAt);
  processedHour.setUTCMinutes(0, 0, 0);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO ${usageEvent} (
        run_id,
        idempotency_key,
        org_id,
        user_id,
        kind,
        provider,
        category,
        quantity,
        credits_charged,
        status,
        created_at,
        processed_at
      ) VALUES (
        NULL,
        ${randomUUID()},
        ${args.orgId},
        ${args.userId},
        'connector',
        'overflow-fixture',
        'call',
        9223372036854775807,
        0,
        'processed',
        ${args.processedAt},
        ${args.processedAt}
      )
    `);
    await tx.insert(usageEventHourlyRollup).values({
      processedHour,
      orgId: args.orgId,
      userId: args.userId,
      runId: null,
      kind: "connector",
      provider: "overflow-fixture",
      category: "call",
      shortWindowId: null,
      weeklyWindowId: null,
      quantity: 1,
      creditsCharged: 0,
      allowanceUnits: 0,
    });
  });
}

async function setUsageEventCreatedAt(
  db: Db,
  args: { readonly id: string; readonly createdAt: Date },
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db
    .select({
      runId: usageEvent.runId,
      originalCreatedAt: usageEvent.createdAt,
    })
    .from(usageEvent)
    .where(eq(usageEvent.id, args.id))
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    return;
  }
  const where = row.runId
    ? and(
        eq(usageEvent.runId, row.runId),
        eq(usageEvent.createdAt, row.originalCreatedAt),
      )
    : eq(usageEvent.id, args.id);
  await db.update(usageEvent).set({ createdAt: args.createdAt }).where(where);
  signal.throwIfAborted();
}

async function materializeHourlyUsage(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string | null;
  },
  signal: AbortSignal,
): Promise<number> {
  return await db.transaction(async (tx) => {
    const runPredicate =
      args.runId === null
        ? isNull(usageEvent.runId)
        : eq(usageEvent.runId, args.runId);
    const rows = await tx
      .select({
        id: usageEvent.id,
        processedHour: sql`date_trunc('hour', ${usageEvent.processedAt})`
          .mapWith(usageEvent.createdAt)
          .as("processed_hour"),
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        runId: usageEvent.runId,
        kind: usageEvent.kind,
        provider: usageEvent.provider,
        category: usageEvent.category,
        shortWindowId: usageAllowanceAllocations.shortWindowId,
        weeklyWindowId: usageAllowanceAllocations.weeklyWindowId,
        quantity: usageEvent.quantity,
        creditsCharged: usageEvent.creditsCharged,
        allowanceUnits: usageAllowanceAllocations.unitsApplied,
      })
      .from(usageEvent)
      .leftJoin(
        usageAllowanceAllocations,
        eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
      )
      .where(
        and(
          eq(usageEvent.orgId, args.orgId),
          eq(usageEvent.userId, args.userId),
          runPredicate,
          eq(usageEvent.status, "processed"),
          isNotNull(usageEvent.processedAt),
        ),
      );
    signal.throwIfAborted();

    if (rows.length === 0) {
      return 0;
    }

    await tx.insert(usageEventHourlyRollup).values(
      rows.map((row) => {
        return {
          processedHour: row.processedHour,
          orgId: row.orgId,
          userId: row.userId,
          runId: row.runId,
          kind: row.kind,
          provider: row.provider,
          category: row.category,
          shortWindowId: row.shortWindowId,
          weeklyWindowId: row.weeklyWindowId,
          quantity: row.quantity,
          creditsCharged: row.creditsCharged ?? 0,
          allowanceUnits: row.allowanceUnits ?? 0,
        };
      }),
    );
    signal.throwIfAborted();

    await tx.delete(usageEvent).where(
      inArray(
        usageEvent.id,
        rows.map((row) => {
          return row.id;
        }),
      ),
    );
    signal.throwIfAborted();
    return rows.length;
  });
}

async function readUsageStorageCounts(
  db: Db,
  args: {
    readonly scope: "organization" | "user";
    readonly id: string;
  },
): Promise<{ readonly raw: number; readonly hourly: number }> {
  const rawPredicate =
    args.scope === "organization"
      ? eq(usageEvent.orgId, args.id)
      : eq(usageEvent.userId, args.id);
  const hourlyPredicate =
    args.scope === "organization"
      ? eq(usageEventHourlyRollup.orgId, args.id)
      : eq(usageEventHourlyRollup.userId, args.id);
  const [[raw], [hourly]] = await Promise.all([
    db.select({ value: count() }).from(usageEvent).where(rawPredicate),
    db
      .select({ value: count() })
      .from(usageEventHourlyRollup)
      .where(hourlyPredicate),
  ]);
  return {
    raw: raw?.value ?? 0,
    hourly: hourly?.value ?? 0,
  };
}

async function deleteUsageData(
  db: Db,
  scope: "organization" | "user",
  id: string,
): Promise<void> {
  if (scope === "organization") {
    await deleteOrgUsageData(db, id);
    return;
  }
  await deleteUserUsageData(db, id);
}

async function mutateUsageInsightFixtureState(
  db: Db,
  body: UsageInsightFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-fixture": {
      const fixture = await seedUsageInsightFixture(db);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { ok: true as const, fixture: fixtureToWire(fixture) },
      };
    }
    case "delete-fixture": {
      await deleteUsageInsightFixture(
        db,
        fixtureFromWire(body.fixture),
        signal,
      );
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "seed-compose": {
      const result = await seedCompose(db, {
        orgId: body.org_id,
        userId: body.user_id,
        name: body.name,
        displayName: body.display_name,
        visibility: body.visibility,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          compose_id: result.composeId,
          agent_id: result.agentId,
        },
      };
    }
  }
}

async function mutateUsageInsightRunState(
  db: Db,
  body: UsageInsightRunAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-run": {
      const result = await seedRun(
        db,
        {
          orgId: body.org_id,
          userId: body.user_id,
          composeId: body.compose_id,
          triggerSource: body.trigger_source,
          chatThreadId: body.chat_thread_id,
          status: body.status,
          prompt: body.prompt,
          createdAt: parseMaybeDate(body.created_at),
          startedAt:
            body.started_at === undefined
              ? undefined
              : parseOptionalDate(body.started_at),
          completedAt:
            body.completed_at === undefined
              ? undefined
              : parseOptionalDate(body.completed_at),
          continuedFromSessionId: body.continued_from_session_id,
          sandboxReuseResult: body.sandbox_reuse_result,
          result: body.result,
          error: body.error,
          lastEventSequence: body.last_event_sequence,
          selectedModel: body.selected_model,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: { ok: true as const, run_id: result.runId },
      };
    }
    case "seed-chat-thread": {
      const threadId = await seedChatThread(
        db,
        {
          userId: body.user_id,
          composeId: body.compose_id,
          title: body.title,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: { ok: true as const, chat_thread_id: threadId },
      };
    }
  }
}

async function mutateUsageInsightEventWriteState(
  db: Db,
  body: UsageInsightEventWriteAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "insert-model-usage-event-for-run": {
      const result = await insertModelUsageEventForRun(db, {
        orgId: body.org_id,
        userId: body.user_id,
        runId: body.run_id,
        inputTokens: body.input_tokens,
        outputTokens: body.output_tokens,
        cacheReadInputTokens: body.cache_read_input_tokens,
        cacheCreationInputTokens: body.cache_creation_input_tokens,
        creditsCharged: body.credits_charged,
        status: body.status,
        processedAt:
          body.processed_at === undefined
            ? undefined
            : parseOptionalDate(body.processed_at),
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { ok: true as const, usage_event_id: result.id },
      };
    }
    case "insert-usage-event": {
      const id = await insertUsageEvent(db, {
        orgId: body.org_id,
        userId: body.user_id,
        runId: body.run_id,
        kind: body.kind,
        provider: body.provider,
        category: body.category,
        quantity: body.quantity,
        status: body.status,
        creditsCharged: body.credits_charged,
        idempotencyKey: body.idempotency_key,
        billingError: body.billing_error,
        createdAt: parseMaybeDate(body.created_at),
        processedAt:
          body.processed_at === undefined
            ? undefined
            : parseOptionalDate(body.processed_at),
        count: body.count,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { ok: true as const, usage_event_id: id },
      };
    }
    case "set-browser-usage-hold": {
      await setBrowserUsageHold(db, {
        orgId: body.org_id,
        userId: body.user_id,
        runId: body.run_id,
        chatThreadId: body.chat_thread_id,
        idempotencyKey: body.idempotency_key,
        settled: body.settled,
      });
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "attach-usage-allowance": {
      const windows = await attachUsageAllowance(db, {
        orgId: body.org_id,
        runId: body.run_id,
        usageEventId: body.usage_event_id,
        unitsApplied: body.units_applied,
        consumedUnits: body.consumed_units,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          short_window_id: windows.shortWindowId,
          weekly_window_id: windows.weeklyWindowId,
        },
      };
    }
    case "read-allowance-window-state": {
      const state = await readAllowanceWindowState(db, {
        shortWindowId: body.short_window_id,
        weeklyWindowId: body.weekly_window_id,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          short_window_consumed_units: state.shortWindowConsumedUnits,
          weekly_window_consumed_units: state.weeklyWindowConsumedUnits,
          raw_allowance_units: state.rawAllowanceUnits,
          hourly_allowance_units: state.hourlyAllowanceUnits,
          allocation_count: state.allocationCount,
        },
      };
    }
  }
}

async function mutateUsageInsightEventMaterializationState(
  db: Db,
  body: UsageInsightEventMaterializationAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "delete-run": {
      await deleteRun(db, body.run_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "seed-usage-overflow-grain": {
      await seedUsageOverflowGrain(db, {
        orgId: body.org_id,
        userId: body.user_id,
        processedAt: new Date(body.processed_at),
      });
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "set-usage-event-created-at": {
      await setUsageEventCreatedAt(
        db,
        { id: body.id, createdAt: new Date(body.created_at) },
        signal,
      );
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "materialize-hourly-usage": {
      const hourlyCount = await materializeHourlyUsage(
        db,
        {
          orgId: body.org_id,
          userId: body.user_id,
          runId: body.run_id,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: { ok: true as const, hourly_count: hourlyCount },
      };
    }
    case "read-usage-storage-counts": {
      const counts = await readUsageStorageCounts(db, {
        scope: body.scope,
        id: body.id,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          raw_count: counts.raw,
          hourly_count: counts.hourly,
        },
      };
    }
  }
}

async function mutateUsageInsightCleanupState(
  db: Db,
  body: UsageInsightCleanupAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "delete-usage-data": {
      await deleteUsageData(db, body.scope, body.id);
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

async function mutateUsageInsightState(
  db: Db,
  body: TestUsageInsightStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-fixture":
    case "delete-fixture":
    case "seed-compose": {
      return await mutateUsageInsightFixtureState(db, body, signal);
    }
    case "seed-run":
    case "seed-chat-thread": {
      return await mutateUsageInsightRunState(db, body, signal);
    }
    case "insert-model-usage-event-for-run":
    case "insert-usage-event":
    case "set-browser-usage-hold":
    case "attach-usage-allowance":
    case "read-allowance-window-state": {
      return await mutateUsageInsightEventWriteState(db, body, signal);
    }
    case "delete-run":
    case "seed-usage-overflow-grain":
    case "set-usage-event-created-at":
    case "materialize-hourly-usage":
    case "read-usage-storage-counts": {
      return await mutateUsageInsightEventMaterializationState(
        db,
        body,
        signal,
      );
    }
    case "delete-usage-data": {
      return await mutateUsageInsightCleanupState(db, body, signal);
    }
  }
}

const mutateUsageInsightState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await mutateUsageInsightState(
      set(writeDb$),
      bodyResult.data,
      signal,
    );
  },
);

export const testUsageInsightStateRoutes: readonly RouteEntry[] = [
  {
    route: testUsageInsightStateContract.action,
    handler: mutateUsageInsightState$,
  },
];
