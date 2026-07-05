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
import { automations } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
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
  readonly automationId?: string;
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

interface BonusUsageEvent {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly creditsCharged: number;
  readonly status: string;
}

interface AutomationBatchEntry {
  readonly credits: number;
  readonly bonus?: BonusUsageEvent | null;
}

type UsageInsightAction<
  Action extends TestUsageInsightStateActionBody["action"],
> = Extract<TestUsageInsightStateActionBody, { readonly action: Action }>;

type UsageInsightFixtureAction = UsageInsightAction<
  "seed-fixture" | "delete-fixture" | "seed-compose"
>;

type UsageInsightRunAction = UsageInsightAction<
  "seed-run" | "seed-automation" | "seed-chat-thread"
>;

type UsageInsightEventAction = UsageInsightAction<
  | "insert-model-usage-event-for-run"
  | "insert-usage-event"
  | "set-usage-event-created-at"
  | "seed-automation-batch"
>;

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

async function deleteUsageInsightFixture(
  db: Db,
  fixture: UsageInsightFixture,
  signal: AbortSignal,
): Promise<void> {
  const orgId = fixture.orgId;
  const userId = fixture.userId;

  await db
    .delete(usageEvent)
    .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.userId, userId)));
  signal.throwIfAborted();

  await db
    .delete(modelUsageObservation)
    .where(
      and(
        eq(modelUsageObservation.orgId, orgId),
        eq(modelUsageObservation.userId, userId),
      ),
    );
  signal.throwIfAborted();

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

  await db
    .delete(automations)
    .where(and(eq(automations.orgId, orgId), eq(automations.userId, userId)));
  signal.throwIfAborted();

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

async function seedAutomation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly name?: string;
    readonly description?: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const [thread] = await db
    .insert(chatThreads)
    .values({ userId: args.userId, agentComposeId: args.agentId })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("seedAutomation: chat thread insert returned no row");
  }
  const [row] = await db
    .insert(automations)
    .values({
      agentId: args.agentId,
      userId: args.userId,
      orgId: args.orgId,
      name: args.name ?? `sched-${randomUUID().slice(0, 8)}`,
      description: args.description,
      instruction: "test",
      interpreterKind: "default",
      chatThreadId: thread.id,
    })
    .returning({ id: automations.id });
  signal.throwIfAborted();
  if (!row) {
    throw new Error("seedAutomation: insert returned no row");
  }
  return row.id;
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
    readonly createdAt?: Date;
    readonly processedAt?: Date | null;
  },
): Promise<string> {
  const status = args.status ?? "pending";
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? nowDate()
        : null;
  const values: typeof usageEvent.$inferInsert = {
    runId: args.runId ?? null,
    orgId: args.orgId,
    userId: args.userId ?? "test-user",
    kind: args.kind ?? "connector",
    provider: args.provider ?? "x",
    category: args.category ?? "tweet.read",
    quantity: args.quantity ?? 1,
    status,
    creditsCharged: args.creditsCharged ?? null,
    idempotencyKey: args.idempotencyKey ?? randomUUID(),
    createdAt: args.createdAt ?? nowDate(),
    processedAt,
  };
  const [row] = await db
    .insert(usageEvent)
    .values(values)
    .returning({ id: usageEvent.id });
  if (!row) {
    throw new Error("insertUsageEvent: insert returned no row");
  }
  return row.id;
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

async function seedAutomationBatch(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId: string;
    readonly entries: readonly AutomationBatchEntry[];
  },
): Promise<{ automationIds: string[] }> {
  const results = await Promise.all(
    args.entries.map(async (entry) => {
      const [thread] = await db
        .insert(chatThreads)
        .values({ userId: args.userId, agentComposeId: args.composeId })
        .returning({ id: chatThreads.id });
      if (!thread) {
        throw new Error(
          "seedAutomationBatch: chat thread insert returned no row",
        );
      }
      const [automationRow] = await db
        .insert(automations)
        .values({
          agentId: args.composeId,
          userId: args.userId,
          orgId: args.orgId,
          name: `sched-${randomUUID().slice(0, 8)}`,
          instruction: "test",
          interpreterKind: "default",
          chatThreadId: thread.id,
        })
        .returning({ id: automations.id });
      if (!automationRow) {
        throw new Error(
          "seedAutomationBatch: automation insert returned no row",
        );
      }
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
      const [session] = await db
        .insert(agentSessions)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          agentComposeId: args.composeId,
        })
        .returning({ id: agentSessions.id });
      if (!session) {
        throw new Error("seedAutomationBatch: session insert returned no row");
      }
      const [run] = await db
        .insert(agentRuns)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          agentComposeVersionId: versionId,
          prompt: "test prompt",
          status: "completed",
          sessionId: session.id,
        })
        .returning({ id: agentRuns.id });
      if (!run) {
        throw new Error("seedAutomationBatch: run insert returned no row");
      }
      await db.insert(zeroRuns).values({
        id: run.id,
        triggerSource: "automation",
      });
      await db.insert(usageEvent).values({
        runId: run.id,
        orgId: args.orgId,
        userId: args.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 100,
        creditsCharged: entry.credits,
        status: "processed",
        idempotencyKey: randomUUID(),
        createdAt: nowDate(),
        processedAt: nowDate(),
      });
      if (entry.bonus) {
        await db.insert(usageEvent).values({
          runId: run.id,
          orgId: args.orgId,
          userId: args.userId,
          kind: entry.bonus.kind,
          provider: entry.bonus.provider,
          category: entry.bonus.category,
          quantity: entry.bonus.quantity,
          creditsCharged: entry.bonus.creditsCharged,
          status: entry.bonus.status,
          idempotencyKey: randomUUID(),
          createdAt: nowDate(),
          processedAt: entry.bonus.status === "processed" ? nowDate() : null,
        });
      }
      return automationRow.id;
    }),
  );
  return { automationIds: results };
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
          automationId: body.automation_id,
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
    case "seed-automation": {
      const automationId = await seedAutomation(
        db,
        {
          orgId: body.org_id,
          userId: body.user_id,
          agentId: body.agent_id,
          name: body.name,
          description: body.description,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: { ok: true as const, automation_id: automationId },
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

function automationBatchEntriesFromWire(
  entries: UsageInsightAction<"seed-automation-batch">["entries"],
): AutomationBatchEntry[] {
  return entries.map((entry) => {
    return {
      credits: entry.credits,
      bonus: entry.bonus
        ? {
            kind: entry.bonus.kind,
            provider: entry.bonus.provider,
            category: entry.bonus.category,
            quantity: entry.bonus.quantity,
            creditsCharged: entry.bonus.credits_charged,
            status: entry.bonus.status,
          }
        : null,
    };
  });
}

async function mutateUsageInsightEventState(
  db: Db,
  body: UsageInsightEventAction,
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
    case "set-usage-event-created-at": {
      await setUsageEventCreatedAt(
        db,
        { id: body.id, createdAt: new Date(body.created_at) },
        signal,
      );
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "seed-automation-batch": {
      const result = await seedAutomationBatch(db, {
        orgId: body.org_id,
        userId: body.user_id,
        composeId: body.compose_id,
        entries: automationBatchEntriesFromWire(body.entries),
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { ok: true as const, automation_ids: result.automationIds },
      };
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
    case "seed-automation":
    case "seed-chat-thread": {
      return await mutateUsageInsightRunState(db, body, signal);
    }
    case "insert-model-usage-event-for-run":
    case "insert-usage-event":
    case "set-usage-event-created-at":
    case "seed-automation-batch": {
      return await mutateUsageInsightEventState(db, body, signal);
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
