import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testUsageStateContract,
  type TestUsageStateActionBody,
} from "@vm0/api-contracts/contracts/test-usage-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { maybeEmitRunUsageMessage$ } from "../services/zero-chat-usage-message.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testUsageStateContract.action);
const insightsQuery$ = queryOf(testUsageStateContract.insights);

interface UsageFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly userIds: readonly string[];
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly displayName?: string | null;
  readonly prompt?: string;
  readonly status?: string;
  readonly triggerSource?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

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

function fixtureToWire(fixture: UsageFixture) {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
    user_ids: [...fixture.userIds],
  };
}

function fixtureFromWire(fixture: {
  readonly org_id: string;
  readonly user_id: string;
  readonly user_ids: readonly string[];
}): UsageFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
    userIds: fixture.user_ids,
  };
}

async function seedUsageFixture(
  db: Db,
  args: {
    readonly currentPeriodEnd?: Date | null;
    readonly tier?: string;
  },
): Promise<UsageFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;

  await db.insert(orgMetadata).values({
    orgId,
    tier: args.tier ?? "free",
    currentPeriodEnd: args.currentPeriodEnd ?? null,
    stripeCustomerId: args.currentPeriodEnd ? `cus_${randomUUID()}` : null,
    stripeSubscriptionId: args.currentPeriodEnd ? `sub_${randomUUID()}` : null,
    subscriptionStatus: args.currentPeriodEnd ? "active" : null,
  });

  return { orgId, userId, userIds: [userId] };
}

async function deleteUsageFixture(
  db: Db,
  fixture: UsageFixture,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(insightsDaily).where(eq(insightsDaily.orgId, fixture.orgId));
  signal.throwIfAborted();

  await db
    .delete(orgMembersCache)
    .where(eq(orgMembersCache.orgId, fixture.orgId));
  signal.throwIfAborted();

  const usageUserRows = await db
    .select({ userId: usageEvent.userId })
    .from(usageEvent)
    .where(eq(usageEvent.orgId, fixture.orgId));
  signal.throwIfAborted();

  await db.delete(usageEvent).where(eq(usageEvent.orgId, fixture.orgId));
  signal.throwIfAborted();

  const runRows = await db
    .select({ id: agentRuns.id, userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, fixture.orgId));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  await db.delete(agentSessions).where(eq(agentSessions.orgId, fixture.orgId));
  signal.throwIfAborted();

  const composeRows = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.orgId, fixture.orgId));
  signal.throwIfAborted();
  const composeIds = composeRows.map((row) => {
    return row.id;
  });
  if (composeIds.length > 0) {
    await db
      .delete(agentComposeVersions)
      .where(inArray(agentComposeVersions.composeId, composeIds));
    signal.throwIfAborted();
    await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
    signal.throwIfAborted();
    await db.delete(agentComposes).where(inArray(agentComposes.id, composeIds));
    signal.throwIfAborted();
  }

  const memberRows = await db
    .select({ userId: orgMembersMetadata.userId })
    .from(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, fixture.orgId));
  signal.throwIfAborted();

  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, fixture.orgId));
  signal.throwIfAborted();

  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  signal.throwIfAborted();

  const userIds = [
    ...new Set([
      ...fixture.userIds,
      ...usageUserRows.map((row) => {
        return row.userId;
      }),
      ...runRows.map((row) => {
        return row.userId;
      }),
      ...memberRows.map((row) => {
        return row.userId;
      }),
    ]),
  ];
  if (userIds.length > 0) {
    await db.delete(userCache).where(inArray(userCache.userId, userIds));
    signal.throwIfAborted();
  }
}

async function insertUsageEvent(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId?: string | null;
    readonly kind?: string;
    readonly provider?: string;
    readonly category?: string;
    readonly quantity?: number;
    readonly creditsCharged?: number | null;
    readonly status?: string;
    readonly createdAt?: Date;
    readonly processedAt?: Date | null;
  },
): Promise<string> {
  const status = args.status ?? "processed";
  const createdAt = args.createdAt ?? nowDate();
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? nowDate()
        : null;
  const [row] = await db
    .insert(usageEvent)
    .values({
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId,
      kind: args.kind ?? "connector",
      provider: args.provider ?? "x",
      category: args.category ?? "tweet.read",
      quantity: args.quantity ?? 1,
      creditsCharged: args.creditsCharged ?? null,
      status,
      createdAt,
      processedAt,
      idempotencyKey: randomUUID(),
    })
    .returning({ id: usageEvent.id });
  if (!row) {
    throw new Error("insertUsageEvent: insert returned no row");
  }
  return row.id;
}

async function insertModelUsage(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId?: string | null;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly creditsCharged?: number | null;
    readonly status?: string;
    readonly createdAt?: Date;
    readonly processedAt?: Date | null;
  },
): Promise<void> {
  const status = args.status ?? "processed";
  const createdAt = args.createdAt ?? nowDate();
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? nowDate()
        : null;
  const rows: (typeof usageEvent.$inferInsert)[] = [
    {
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: args.inputTokens ?? 0,
      creditsCharged: args.creditsCharged ?? null,
      status,
      createdAt,
      processedAt,
      idempotencyKey: randomUUID(),
    },
    {
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.output",
      quantity: args.outputTokens ?? 0,
      creditsCharged: null,
      status,
      createdAt,
      processedAt,
      idempotencyKey: randomUUID(),
    },
    {
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.cache_read",
      quantity: args.cacheReadInputTokens ?? 0,
      creditsCharged: null,
      status,
      createdAt,
      processedAt,
      idempotencyKey: randomUUID(),
    },
    {
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.cache_creation",
      quantity: args.cacheCreationInputTokens ?? 0,
      creditsCharged: null,
      status,
      createdAt,
      processedAt,
      idempotencyKey: randomUUID(),
    },
  ];

  await db.insert(usageEvent).values(rows);
}

async function seedRun(
  db: Db,
  args: SeedRunArgs,
  signal: AbortSignal,
): Promise<{ runId: string; composeId: string }> {
  const composeName = `usage-${randomUUID().slice(0, 8)}`;
  const [compose] = await db
    .insert(agentComposes)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      name: composeName,
      createdAt: args.createdAt,
    })
    .returning({ id: agentComposes.id });
  signal.throwIfAborted();
  if (!compose) {
    throw new Error("seedRun: compose insert returned no row");
  }

  await db.insert(zeroAgents).values({
    id: compose.id,
    orgId: args.orgId,
    owner: args.userId,
    name: composeName,
    displayName: args.displayName ?? null,
  });
  signal.throwIfAborted();

  const versionId = randomUUID();
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose.id,
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
    .where(eq(agentComposes.id, compose.id));
  signal.throwIfAborted();

  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeId: compose.id,
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
      status: args.status ?? "completed",
      sessionId: session.id,
      createdAt: args.createdAt,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    throw new Error("seedRun: run insert returned no row");
  }

  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: args.triggerSource ?? "cli",
  });
  signal.throwIfAborted();

  return { runId: run.id, composeId: compose.id };
}

async function seedChatThreadRun(
  db: Db,
  args: SeedRunArgs & {
    readonly title?: string | null;
    readonly threadId?: string;
  },
  signal: AbortSignal,
): Promise<{ runId: string; threadId: string; composeId: string }> {
  const { runId, composeId } = await seedRun(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      triggerSource: args.triggerSource ?? "web",
      createdAt: args.createdAt,
    },
    signal,
  );
  signal.throwIfAborted();

  let threadId = args.threadId;
  if (!threadId) {
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: args.userId,
        agentComposeId: composeId,
        title: args.title ?? null,
      })
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    if (!thread) {
      throw new Error("seedChatThreadRun: thread insert returned no row");
    }
    threadId = thread.id;
  }

  await db
    .update(zeroRuns)
    .set({ chatThreadId: threadId })
    .where(eq(zeroRuns.id, runId));
  signal.throwIfAborted();

  return { runId, threadId, composeId };
}

function defaultInsightsData() {
  return {
    agents: [],
    creditsUsed: 0,
    creditBalance: 0,
    teamUsage: [],
    topTask: null,
    services: [],
    permissions: [],
  };
}

type UsageAction<TAction extends TestUsageStateActionBody["action"]> = Extract<
  TestUsageStateActionBody,
  { action: TAction }
>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

async function seedFixtureForAction(
  db: Db,
  body: UsageAction<"seed-fixture">,
  signal: AbortSignal,
) {
  const fixture = await seedUsageFixture(db, {
    currentPeriodEnd: parseOptionalDate(body.current_period_end),
    tier: body.tier,
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { ok: true as const, fixture: fixtureToWire(fixture) },
  };
}

async function insertUsageEventForAction(
  db: Db,
  body: UsageAction<"insert-usage-event">,
  signal: AbortSignal,
) {
  const id = await insertUsageEvent(db, {
    orgId: body.org_id,
    userId: body.user_id,
    runId: body.run_id,
    kind: body.kind,
    provider: body.provider,
    category: body.category,
    quantity: body.quantity,
    creditsCharged: body.credits_charged,
    status: body.status,
    createdAt: parseMaybeDate(body.created_at),
    processedAt:
      body.processed_at === undefined
        ? undefined
        : parseOptionalDate(body.processed_at),
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { ok: true as const, usage_event_id: id },
  };
}

async function seedUsagePricingForAction(
  db: Db,
  body: UsageAction<"seed-usage-pricing">,
  signal: AbortSignal,
) {
  await db
    .insert(usagePricing)
    .values({
      kind: "connector",
      provider: body.provider,
      category: body.category,
      unitPrice: body.unit_price,
      unitSize: body.unit_size,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: body.unit_price,
        unitSize: body.unit_size,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function insertModelUsageForAction(
  db: Db,
  body: UsageAction<"insert-model-usage">,
  signal: AbortSignal,
) {
  await insertModelUsage(db, {
    orgId: body.org_id,
    userId: body.user_id,
    runId: body.run_id,
    inputTokens: body.input_tokens,
    outputTokens: body.output_tokens,
    cacheReadInputTokens: body.cache_read_input_tokens,
    cacheCreationInputTokens: body.cache_creation_input_tokens,
    creditsCharged: body.credits_charged,
    status: body.status,
    createdAt: parseMaybeDate(body.created_at),
    processedAt:
      body.processed_at === undefined
        ? undefined
        : parseOptionalDate(body.processed_at),
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedRunForAction(
  db: Db,
  body: UsageAction<"seed-run">,
  signal: AbortSignal,
) {
  const run = await seedRun(
    db,
    {
      orgId: body.org_id,
      userId: body.user_id,
      displayName: body.display_name,
      prompt: body.prompt,
      status: body.status,
      triggerSource: body.trigger_source,
      createdAt: parseMaybeDate(body.created_at),
      startedAt:
        body.started_at === undefined
          ? undefined
          : parseOptionalDate(body.started_at),
      completedAt:
        body.completed_at === undefined
          ? undefined
          : parseOptionalDate(body.completed_at),
    },
    signal,
  );
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      run_id: run.runId,
      compose_id: run.composeId,
    },
  };
}

async function seedChatThreadRunForAction(
  db: Db,
  body: UsageAction<"seed-chat-thread-run">,
  signal: AbortSignal,
) {
  const run = await seedChatThreadRun(
    db,
    {
      orgId: body.org_id,
      userId: body.user_id,
      title: body.title,
      triggerSource: body.trigger_source,
      threadId: body.thread_id,
      createdAt: parseMaybeDate(body.created_at),
    },
    signal,
  );
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      run_id: run.runId,
      compose_id: run.composeId,
      thread_id: run.threadId,
    },
  };
}

async function setCreditBalanceForAction(
  db: Db,
  body: UsageAction<"set-credit-balance">,
  signal: AbortSignal,
) {
  await db
    .update(orgMetadata)
    .set({ credits: body.credits })
    .where(eq(orgMetadata.orgId, body.org_id));
  signal.throwIfAborted();
  return actionOk();
}

async function setOrgTierForAction(
  db: Db,
  body: UsageAction<"set-org-tier">,
  signal: AbortSignal,
) {
  await db
    .update(orgMetadata)
    .set({ tier: body.tier })
    .where(eq(orgMetadata.orgId, body.org_id));
  signal.throwIfAborted();
  return actionOk();
}

async function seedUserNameForAction(
  db: Db,
  body: UsageAction<"seed-user-name">,
  signal: AbortSignal,
) {
  await db
    .insert(userCache)
    .values({
      userId: body.user_id,
      email: body.email,
      name: body.name,
      cachedAt: new Date(body.cached_at),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: {
        email: body.email,
        name: body.name,
        cachedAt: new Date(body.cached_at),
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function seedCachedOrgMemberForAction(
  db: Db,
  body: UsageAction<"seed-cached-org-member">,
  signal: AbortSignal,
) {
  await db
    .insert(orgMembersCache)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      role: "member",
      cachedAt: new Date(body.cached_at),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role: "member", cachedAt: new Date(body.cached_at) },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function seedExistingInsightsForAction(
  db: Db,
  body: UsageAction<"seed-existing-insights">,
  signal: AbortSignal,
) {
  await db.insert(insightsDaily).values({
    orgId: body.org_id,
    userId: body.user_id,
    date: body.date,
    updatedAt: new Date(body.updated_at),
    data: body.data ?? defaultInsightsData(),
  });
  signal.throwIfAborted();
  return actionOk();
}

const mutateUsageState$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(actionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const db = set(writeDb$);
  const body = bodyResult.data;

  switch (body.action) {
    case "seed-fixture": {
      return await seedFixtureForAction(db, body, signal);
    }
    case "delete-fixture": {
      await deleteUsageFixture(db, fixtureFromWire(body.fixture), signal);
      return actionOk();
    }
    case "insert-usage-event": {
      return await insertUsageEventForAction(db, body, signal);
    }
    case "seed-usage-pricing": {
      return await seedUsagePricingForAction(db, body, signal);
    }
    case "emit-run-usage-message": {
      const emitted = await set(maybeEmitRunUsageMessage$, body.run_id, signal);
      return {
        status: 200 as const,
        body: { ok: true as const, emitted },
      };
    }
    case "insert-model-usage": {
      return await insertModelUsageForAction(db, body, signal);
    }
    case "seed-run": {
      return await seedRunForAction(db, body, signal);
    }
    case "seed-chat-thread-run": {
      return await seedChatThreadRunForAction(db, body, signal);
    }
    case "set-credit-balance": {
      return await setCreditBalanceForAction(db, body, signal);
    }
    case "set-org-tier": {
      return await setOrgTierForAction(db, body, signal);
    }
    case "seed-user-name": {
      return await seedUserNameForAction(db, body, signal);
    }
    case "seed-cached-org-member": {
      return await seedCachedOrgMemberForAction(db, body, signal);
    }
    case "seed-existing-insights": {
      return await seedExistingInsightsForAction(db, body, signal);
    }
  }
});

const readUsageInsightsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(insightsQuery$);
    const db = set(writeDb$);
    const [row] = await db
      .select({ data: insightsDaily.data })
      .from(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, query.org_id),
          eq(insightsDaily.userId, query.user_id),
          eq(insightsDaily.date, query.date),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { data: (row?.data as unknown | undefined) ?? null },
    };
  },
);

export const testUsageStateRoutes: readonly RouteEntry[] = [
  {
    route: testUsageStateContract.action,
    handler: mutateUsageState$,
  },
  {
    route: testUsageStateContract.insights,
    handler: readUsageInsightsState$,
  },
];
