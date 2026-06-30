import { randomUUID } from "node:crypto";

import {
  getProviderRuntimeModel,
  getVm0Vendor,
  MODEL_PROVIDER_TYPES,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { command } from "ccstate";
import { testAutomationsStateContract } from "@vm0/api-contracts/contracts/test-automations-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { userCache } from "@vm0/db/schema/user-cache";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, eq, inArray } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../lib/secret-kms-client";
import { testOverride } from "../../lib/singleton";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const postBody$ = bodyResultOf(testAutomationsStateContract.post);
const getQuery$ = queryOf(testAutomationsStateContract.get);
const patchBody$ = bodyResultOf(testAutomationsStateContract.patch);
const actionBody$ = bodyResultOf(testAutomationsStateContract.action);
const deleteQuery$ = queryOf(testAutomationsStateContract.delete);
const fakeKmsDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY =
  "vm0-key-run-lifecycle-bdd-default-model";
const fakeKmsDecryptCallCount = testOverride<number>(() => {
  return 0;
});

interface AutomationSeed {
  readonly name: string;
  readonly prompt: string;
  readonly description?: string | null;
  readonly cronExpression?: string;
  readonly atTime?: Date;
  readonly intervalSeconds?: number;
  readonly triggerType?: "cron" | "once" | "loop";
  readonly enabled?: boolean;
  readonly nextRunAt?: Date | null;
  readonly lastRunId?: string | null;
  readonly appendSystemPrompt?: string | null;
  readonly timezone?: string;
  readonly consecutiveFailures?: number;
}

interface AutomationsScenarioValues {
  readonly automations: readonly AutomationSeed[];
  readonly displayName?: string;
  readonly agentName?: string;
  readonly userName?: string | null;
  readonly userEmail?: string | null;
  readonly timezone?: string | null;
  readonly framework?: "claude-code" | "codex";
}

interface AutomationsFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly automationIds: readonly string[];
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return new Date(value);
}

function resolveTriggerType(seed: AutomationSeed): "cron" | "once" | "loop" {
  if (seed.triggerType) {
    return seed.triggerType;
  }
  if (seed.cronExpression) {
    return "cron";
  }
  if (seed.atTime) {
    return "once";
  }
  return "loop";
}

function agentEnvironment(
  framework: "claude-code" | "codex",
): Record<string, string> {
  return framework === "codex"
    ? { OPENAI_API_KEY: "test-key" }
    : { ANTHROPIC_API_KEY: "test-key" };
}

async function seedAutomation(
  writeDb: Db,
  args: {
    readonly seed: AutomationSeed;
    readonly composeId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<string> {
  const [thread] = await writeDb
    .insert(chatThreads)
    .values({ userId: args.userId, agentComposeId: args.composeId })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("seedAutomation: chat thread insert returned no row");
  }
  const enabled = args.seed.enabled ?? true;
  const [automation] = await writeDb
    .insert(automations)
    .values({
      agentId: args.composeId,
      userId: args.userId,
      orgId: args.orgId,
      name: args.seed.name,
      chatThreadId: thread.id,
      instruction: args.seed.prompt,
      description: args.seed.description ?? null,
      appendSystemPrompt: args.seed.appendSystemPrompt ?? null,
      interpreterKind: "time",
      enabled,
    })
    .returning({ id: automations.id });
  if (!automation) {
    throw new Error("seedAutomation: automation insert returned no row");
  }
  await writeDb.insert(automationTriggers).values({
    automationId: automation.id,
    kind: resolveTriggerType(args.seed),
    cronExpression: args.seed.cronExpression ?? null,
    atTime: args.seed.atTime ?? null,
    intervalSeconds: args.seed.intervalSeconds ?? null,
    timezone: args.seed.timezone ?? "UTC",
    nextRunAt: args.seed.nextRunAt ?? null,
    lastRunId: args.seed.lastRunId ?? null,
    enabled,
    consecutiveFailures: args.seed.consecutiveFailures ?? 0,
  });
  return automation.id;
}

async function seedAutomationsScenario(
  writeDb: Db,
  values: AutomationsScenarioValues,
  signal: AbortSignal,
): Promise<AutomationsFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const composeId = randomUUID();
  const versionId = randomUUID();
  const agentName = values.agentName ?? `agent-${composeId.slice(0, 8)}`;
  const framework = values.framework ?? "claude-code";

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: agentName,
  });
  signal.throwIfAborted();

  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: {
      version: "1.0",
      agents: {
        [agentName]: {
          framework,
          environment: agentEnvironment(framework),
        },
      },
    },
    createdBy: userId,
  });
  signal.throwIfAborted();

  await writeDb
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  signal.throwIfAborted();

  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    name: agentName,
    displayName: values.displayName ?? "Test Agent",
    description: null,
    sound: null,
  });
  signal.throwIfAborted();

  await writeDb.insert(userCache).values({
    userId,
    name: values.userName ?? null,
    email: values.userEmail ?? `${userId}@example.com`,
  });
  signal.throwIfAborted();

  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  signal.throwIfAborted();

  await writeDb.insert(orgMembersMetadata).values({
    userId,
    orgId,
    timezone: values.timezone ?? null,
  });
  signal.throwIfAborted();

  await writeDb.insert(orgMembersCache).values({
    userId,
    orgId,
    role: "member",
  });
  signal.throwIfAborted();

  const automationIds: string[] = [];
  for (const seed of values.automations) {
    const automationId = await seedAutomation(writeDb, {
      seed,
      composeId,
      userId,
      orgId,
    });
    signal.throwIfAborted();
    automationIds.push(automationId);
  }

  return { orgId, userId, composeId, automationIds };
}

async function deleteAutomationsScenario(
  writeDb: Db,
  fixture: AutomationsFixture,
  signal: AbortSignal,
): Promise<void> {
  const runRows = await writeDb
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await writeDb
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    signal.throwIfAborted();
    await writeDb
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    signal.throwIfAborted();
    await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    signal.throwIfAborted();
  }

  if (fixture.automationIds.length > 0) {
    await writeDb
      .delete(automations)
      .where(inArray(automations.id, [...fixture.automationIds]));
    signal.throwIfAborted();
  }
  if (runIds.length > 0) {
    await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }
  await writeDb
    .delete(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, fixture.orgId),
        eq(agentSessions.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.composeId));
  signal.throwIfAborted();
  await writeDb
    .delete(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, fixture.orgId),
        eq(userPermissionGrants.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await writeDb
    .delete(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, fixture.orgId),
        eq(userConnectors.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, fixture.composeId));
  signal.throwIfAborted();
  await writeDb
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  signal.throwIfAborted();
  await writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  signal.throwIfAborted();
  await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  signal.throwIfAborted();
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
  signal.throwIfAborted();
  await writeDb.delete(userCache).where(eq(userCache.userId, fixture.userId));
  signal.throwIfAborted();
  await writeDb
    .delete(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, fixture.orgId));
  signal.throwIfAborted();
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  signal.throwIfAborted();
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await writeDb
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, fixture.orgId),
        eq(orgMembersCache.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function idsFromCsv(value: string | undefined): string[] {
  return value?.split(",").filter(Boolean) ?? [];
}

async function loadAutomationState(db: Db, automationId: string | undefined) {
  if (!automationId) {
    return null;
  }
  const [automation] = await db
    .select({
      id: automations.id,
      orgId: automations.orgId,
      enabled: automations.enabled,
      interpreterKind: automations.interpreterKind,
      chatThreadId: automations.chatThreadId,
    })
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1);
  if (!automation) {
    return null;
  }
  const [thread] = await db
    .select({
      title: chatThreads.title,
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, automation.chatThreadId))
    .limit(1);
  return {
    id: automation.id,
    org_id: automation.orgId,
    enabled: automation.enabled,
    interpreter_kind: automation.interpreterKind,
    chat_thread_id: automation.chatThreadId,
    chat_thread: thread
      ? {
          title: thread.title,
          user_id: thread.userId,
          agent_compose_id: thread.agentComposeId,
        }
      : null,
  };
}

async function loadTriggerRows(db: Db, automationIds: readonly string[]) {
  if (automationIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      id: automationTriggers.id,
      automationId: automationTriggers.automationId,
      kind: automationTriggers.kind,
      cronExpression: automationTriggers.cronExpression,
      atTime: automationTriggers.atTime,
      intervalSeconds: automationTriggers.intervalSeconds,
      timezone: automationTriggers.timezone,
      enabled: automationTriggers.enabled,
      nextRunAt: automationTriggers.nextRunAt,
      lastRunId: automationTriggers.lastRunId,
      consecutiveFailures: automationTriggers.consecutiveFailures,
    })
    .from(automationTriggers)
    .where(inArray(automationTriggers.automationId, [...automationIds]))
    .orderBy(asc(automationTriggers.createdAt), asc(automationTriggers.id));
  return rows.map((row) => {
    return {
      id: row.id,
      automation_id: row.automationId,
      kind: row.kind,
      cron_expression: row.cronExpression,
      at_time: iso(row.atTime),
      interval_seconds: row.intervalSeconds,
      timezone: row.timezone,
      enabled: row.enabled,
      next_run_at: iso(row.nextRunAt),
      last_run_id: row.lastRunId,
      consecutive_failures: row.consecutiveFailures,
    };
  });
}

async function loadRunsForAutomations(
  db: Db,
  automationIds: readonly string[],
) {
  if (automationIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      id: zeroRuns.id,
      automationId: zeroRuns.automationId,
    })
    .from(zeroRuns)
    .where(inArray(zeroRuns.automationId, [...automationIds]));
  return rows.map((row) => {
    return {
      id: row.id,
      automation_id: row.automationId,
    };
  });
}

async function loadRunState(db: Db, runId: string | undefined) {
  if (!runId) {
    return null;
  }
  const [zeroRun] = await db
    .select({
      triggerSource: zeroRuns.triggerSource,
      automationId: zeroRuns.automationId,
      triggerId: zeroRuns.triggerId,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  const [agentRun] = await db
    .select({
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const callbacks = await db
    .select({
      url: agentRunCallbacks.url,
      internalKind: agentRunCallbacks.internalKind,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
  const messages = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      automationTitle: chatMessages.automationTitle,
      automationSnapshot: chatMessages.automationSnapshot,
    })
    .from(chatMessages)
    .where(eq(chatMessages.runId, runId));
  return {
    zero_run: zeroRun
      ? {
          trigger_source: zeroRun.triggerSource,
          automation_id: zeroRun.automationId,
          trigger_id: zeroRun.triggerId,
          chat_thread_id: zeroRun.chatThreadId,
        }
      : null,
    agent_run: agentRun
      ? {
          prompt: agentRun.prompt,
          append_system_prompt: agentRun.appendSystemPrompt,
        }
      : null,
    callbacks: callbacks.map((callback) => {
      return {
        url: callback.url,
        internal_kind: callback.internalKind,
        payload: callback.payload,
      };
    }),
    messages: messages.map((message) => {
      return {
        role: message.role,
        content: message.content,
        automation_title: message.automationTitle,
        automation_snapshot: message.automationSnapshot,
      };
    }),
  };
}

async function cleanupCreatedAutomations(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const rows = await db
    .select({ id: automations.id, chatThreadId: automations.chatThreadId })
    .from(automations)
    .where(eq(automations.orgId, orgId));
  signal.throwIfAborted();
  for (const row of rows) {
    await db.delete(automations).where(eq(automations.id, row.id));
    signal.throwIfAborted();
    await db.delete(chatThreads).where(eq(chatThreads.id, row.chatThreadId));
    signal.throwIfAborted();
  }
}

async function seedCompose(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId?: string;
  },
): Promise<string> {
  const composeId = args.composeId ?? randomUUID();
  await db.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: `agent-extra-${composeId.slice(0, 8)}`,
  });
  return composeId;
}

async function seedRun(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId: string;
    readonly status?: string;
    readonly prompt?: string;
  },
): Promise<string> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeId: args.composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("seedRun: agent session insert returned no row");
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      sessionId: session.id,
      status: args.status ?? "completed",
      prompt: args.prompt ?? "prior run",
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("seedRun: agent run insert returned no row");
  }
  return run.id;
}

function fakeSecretKmsClient(): SecretKmsClient {
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: fakeKmsDataKey,
      });
    }
    fakeKmsDecryptCallCount.set(fakeKmsDecryptCallCount.get() + 1);
    return Promise.resolve({ $metadata: {}, Plaintext: fakeKmsDataKey });
  }
  return { send };
}

async function readComposeHeadVersion(
  db: Db,
  composeId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const [composeRow] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  signal.throwIfAborted();
  return composeRow?.headVersionId ?? null;
}

async function seedVm0ManagedDefaultModelKey(
  db: Db,
  signal: AbortSignal,
): Promise<string> {
  const selectedModel = MODEL_PROVIDER_TYPES.vm0.defaultModel;
  if (!selectedModel) {
    throw new Error("Expected vm0 to define a default model");
  }
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY));
  signal.throwIfAborted();
  await db.insert(vm0ApiKeys).values({
    vendor: getVm0Vendor(selectedModel),
    model: getProviderRuntimeModel("vm0", selectedModel),
    apiKey: RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY,
    label: "run-lifecycle-bdd",
  });
  signal.throwIfAborted();
  return selectedModel;
}

async function deleteVm0ManagedDefaultModelKey(
  db: Db,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY));
  signal.throwIfAborted();
}

const postAutomationsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(postBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const values: AutomationsScenarioValues = {
      ...bodyResult.data,
      automations: bodyResult.data.automations.map((seed) => {
        return {
          ...seed,
          atTime: parseOptionalDate(seed.atTime) ?? undefined,
          nextRunAt: parseOptionalDate(seed.nextRunAt),
        };
      }),
    };
    const fixture = await seedAutomationsScenario(
      set(writeDb$),
      values,
      signal,
    );

    return {
      status: 200 as const,
      body: {
        org_id: fixture.orgId,
        user_id: fixture.userId,
        compose_id: fixture.composeId,
        automation_ids: [...fixture.automationIds],
      },
    };
  },
);

const getAutomationsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(getQuery$);
    const automationIds = [
      ...(query.automation_id ? [query.automation_id] : []),
      ...idsFromCsv(query.automation_ids),
    ];
    const db = set(writeDb$);
    const body = {
      automation: await loadAutomationState(db, query.automation_id),
      triggers: await loadTriggerRows(db, automationIds),
      runs: await loadRunsForAutomations(db, automationIds),
      run: await loadRunState(db, query.run_id),
    };
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

const patchAutomationTriggerState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(patchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    if (!body.trigger_id && !body.automation_id) {
      return {
        status: 400 as const,
        body: { error: "trigger_id or automation_id is required" },
      };
    }

    const setValues: Partial<typeof automationTriggers.$inferInsert> = {};
    if ("at_time" in body) {
      setValues.atTime = parseOptionalDate(body.at_time);
    }
    if ("next_run_at" in body) {
      setValues.nextRunAt = parseOptionalDate(body.next_run_at);
    }
    if ("enabled" in body) {
      setValues.enabled = body.enabled;
    }
    if ("last_run_id" in body) {
      setValues.lastRunId = body.last_run_id ?? null;
    }
    if ("consecutive_failures" in body) {
      setValues.consecutiveFailures = body.consecutive_failures;
    }

    const db = set(writeDb$);
    if (body.trigger_id) {
      await db
        .update(automationTriggers)
        .set(setValues)
        .where(eq(automationTriggers.id, body.trigger_id));
    } else if (body.automation_id) {
      await db
        .update(automationTriggers)
        .set(setValues)
        .where(eq(automationTriggers.automationId, body.automation_id));
    }
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

const postAutomationsStateAction$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const db = set(writeDb$);
    switch (body.action) {
      case "cleanup-created-automations": {
        await cleanupCreatedAutomations(db, body.org_id, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "seed-compose": {
        const composeId = await seedCompose(db, {
          orgId: body.org_id,
          userId: body.user_id,
          composeId: body.compose_id,
        });
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: { ok: true as const, compose_id: composeId },
        };
      }
      case "delete-compose": {
        await db
          .delete(agentComposes)
          .where(eq(agentComposes.id, body.compose_id));
        signal.throwIfAborted();
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "seed-run": {
        const runId = await seedRun(db, {
          orgId: body.org_id,
          userId: body.user_id,
          composeId: body.compose_id,
          status: body.status,
          prompt: body.prompt,
        });
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: { ok: true as const, run_id: runId },
        };
      }
      case "delete-org-member": {
        await db
          .delete(orgMembersCache)
          .where(
            and(
              eq(orgMembersCache.orgId, body.org_id),
              eq(orgMembersCache.userId, body.user_id),
            ),
          );
        signal.throwIfAborted();
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-compose-head-version": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            head_version_id: await readComposeHeadVersion(
              db,
              body.compose_id,
              signal,
            ),
          },
        };
      }
      case "seed-vm0-managed-default-model-key": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            selected_model: await seedVm0ManagedDefaultModelKey(db, signal),
          },
        };
      }
      case "delete-vm0-managed-default-model-key": {
        await deleteVm0ManagedDefaultModelKey(db, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "enable-fake-kms": {
        fakeKmsDecryptCallCount.set(0);
        setSecretKmsClientForTests(fakeSecretKmsClient());
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "reset-fake-kms": {
        resetSecretKmsClientForTests();
        fakeKmsDecryptCallCount.set(0);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-fake-kms-state": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            decrypt_call_count: fakeKmsDecryptCallCount.get(),
          },
        };
      }
    }
  },
);

const deleteAutomationsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(deleteQuery$);
    if (!query.org_id || !query.user_id || !query.compose_id) {
      return {
        status: 400 as const,
        body: { error: "org_id, user_id, and compose_id are required" },
      };
    }

    await deleteAutomationsScenario(
      set(writeDb$),
      {
        orgId: query.org_id,
        userId: query.user_id,
        composeId: query.compose_id,
        automationIds: query.automation_ids
          ? query.automation_ids.split(",").filter(Boolean)
          : [],
      },
      signal,
    );
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testAutomationsStateRoutes: readonly RouteEntry[] = [
  {
    route: testAutomationsStateContract.post,
    handler: postAutomationsState$,
  },
  {
    route: testAutomationsStateContract.get,
    handler: getAutomationsState$,
  },
  {
    route: testAutomationsStateContract.patch,
    handler: patchAutomationTriggerState$,
  },
  {
    route: testAutomationsStateContract.action,
    handler: postAutomationsStateAction$,
  },
  {
    route: testAutomationsStateContract.delete,
    handler: deleteAutomationsState$,
  },
];
