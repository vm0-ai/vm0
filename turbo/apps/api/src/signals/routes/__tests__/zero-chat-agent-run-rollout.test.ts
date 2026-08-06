import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chatEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
import { createStore } from "ccstate";
import { Client } from "pg";
import { z } from "zod";

import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { onRejection, safeJsonParse } from "../../utils";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  insertUsageEvent$,
  readUsageEventState$,
} from "./helpers/zero-usage-insight";
import {
  readChatAgentRunContextSchemaAvailable,
  resetDatabasePool,
} from "./helpers/runtime-state";
import { zeroChatEventsRoutes } from "../zero-chat-events";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const usageSettlement = setupApp({
  context,
  routes: testUsageSettlementRoutes,
})(testUsageSettlementContract);
const migrationJournalSchema = z.object({
  entries: z.array(
    z.object({
      idx: z.number(),
      tag: z.string(),
    }),
  ),
});
const migrationsDirectory = fileURLToPath(
  new URL("../../../../../../packages/db/src/migrations/", import.meta.url),
);

function databaseUrlWithName(
  databaseUrl: string,
  databaseName: string,
): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  url.hash = "";
  return url.toString();
}

function databaseIdentifier(databaseName: string): string {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("Unsafe rollout-test database name");
  }
  return `"${databaseName}"`;
}

async function withDatabaseClient<T>(
  databaseUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const result = await onRejection(operation(client), () => {
    return client.end();
  });
  await client.end();
  return result;
}

async function readOrgCredits(
  databaseUrl: string,
  orgId: string,
): Promise<number> {
  return await withDatabaseClient(databaseUrl, async (client) => {
    const result = await client.query<{ readonly credits: string }>(
      `SELECT credits::text AS credits
       FROM org_metadata
       WHERE org_id = $1`,
      [orgId],
    );
    const credits = Number(result.rows[0]?.credits);
    if (!Number.isSafeInteger(credits)) {
      throw new Error("Expected a safe rollout credit balance");
    }
    return credits;
  });
}

async function findAgentRunContextMigration(
  journal: z.infer<typeof migrationJournalSchema>,
): Promise<(typeof journal.entries)[number] | undefined> {
  for (const migration of journal.entries) {
    const migrationSql = await readFile(
      `${migrationsDirectory}${migration.tag}.sql`,
      "utf8",
    );
    if (migrationSql.includes('CREATE TABLE "chat_agent_run_context"')) {
      return migration;
    }
  }
  return undefined;
}

async function applyMigrationsBeforeAgentRunContext(
  databaseUrl: string,
): Promise<void> {
  const rawJournal = safeJsonParse(
    await readFile(`${migrationsDirectory}meta/_journal.json`, "utf8"),
  );
  const journal = migrationJournalSchema.parse(rawJournal);
  const rolloutMigration = await findAgentRunContextMigration(journal);
  if (!rolloutMigration) {
    throw new Error(
      "Expected the chat agent-run context migration in the migration journal",
    );
  }

  await withDatabaseClient(databaseUrl, async (client) => {
    for (const migration of journal.entries) {
      if (migration.idx >= rolloutMigration.idx) {
        break;
      }
      const migrationSql = await readFile(
        `${migrationsDirectory}${migration.tag}.sql`,
        "utf8",
      );
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim().length > 0) {
          await client.query(statement);
        }
      }
    }
  });
}

async function applyInputSourceDiscriminatorContract(
  databaseUrl: string,
): Promise<void> {
  await withDatabaseClient(databaseUrl, async (client) => {
    await client.query(`
      ALTER TABLE "chat_events"
        DROP CONSTRAINT "chat_events_context_pair_check",
        DROP CONSTRAINT "chat_events_context_type_check",
        ADD CONSTRAINT "chat_events_context_pair_check"
          CHECK ("context_id" IS NULL OR "context_type" IS NOT NULL),
        ADD CONSTRAINT "chat_events_context_type_check"
          CHECK ("context_type" IN (
            'slack',
            'feishu',
            'teams',
            'telegram',
            'github',
            'agentphone',
            'automation',
            'goal',
            'morning_brief',
            'web'
          ))
    `);
  });
}

async function createPreAgentRunContextDatabase(
  originalDatabaseUrl: string,
  databaseName: string,
): Promise<string> {
  const adminUrl = databaseUrlWithName(originalDatabaseUrl, "postgres");
  await withDatabaseClient(adminUrl, async (admin) => {
    await admin.query(`CREATE DATABASE ${databaseIdentifier(databaseName)}`);
  });

  const preMigrationUrl = databaseUrlWithName(
    originalDatabaseUrl,
    databaseName,
  );
  await applyMigrationsBeforeAgentRunContext(preMigrationUrl);
  // The current API requires the input-source discriminator migration to run
  // first. Apply only that independent constraint contract while keeping the
  // agent-run context table absent for this focused compatibility probe.
  await applyInputSourceDiscriminatorContract(preMigrationUrl);
  return preMigrationUrl;
}

async function dropDatabase(
  originalDatabaseUrl: string,
  databaseName: string,
): Promise<void> {
  const adminUrl = databaseUrlWithName(originalDatabaseUrl, "postgres");
  await withDatabaseClient(adminUrl, async (admin) => {
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)} WITH (FORCE)`,
    );
  });
}

async function runPreAgentRunContextRouteProbe(
  originalDatabaseUrl: string,
  databaseName: string,
): Promise<void> {
  const preMigrationUrl = await createPreAgentRunContextDatabase(
    originalDatabaseUrl,
    databaseName,
  );
  await resetDatabasePool(context);
  mockEnv("DATABASE_URL", preMigrationUrl);
  await installApiTestConnectorCatalog();

  await expect(
    readChatAgentRunContextSchemaAvailable(context),
  ).resolves.toBeFalsy();

  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const runnerGroup = api.configureRunnerGroup();
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped rollout actor");
  }
  await api.grantProEntitlement(actor);

  // Migration 0845 is intentionally absent here. Settlement must probe the
  // schema without aborting its transaction, then preserve shared credits.
  const rolloutProvider = `usage-pack-rollout-${randomUUID()}`;
  await seedUsagePricingRows([
    {
      kind: "model",
      provider: rolloutProvider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    },
  ]);
  const creditsBeforeSettlement = await readOrgCredits(
    preMigrationUrl,
    actor.orgId,
  );
  const usageEventKey = randomUUID();
  await store.set(
    insertUsageEvent$,
    {
      orgId: actor.orgId,
      userId: actor.userId,
      kind: "model",
      provider: rolloutProvider,
      category: "tokens.input",
      quantity: 1,
      idempotencyKey: usageEventKey,
    },
    context.signal,
  );
  await accept(
    usageSettlement.process({ body: { org_id: actor.orgId } }),
    [200],
  );
  await expect(
    store.set(readUsageEventState$, usageEventKey, context.signal),
  ).resolves.toMatchObject({ status: "processed", creditsCharged: 1 });
  await expect(readOrgCredits(preMigrationUrl, actor.orgId)).resolves.toBe(
    creditsBeforeSettlement - 1,
  );

  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Pre-agent-run-context rollout agent",
    visibility: "private",
  });
  const source = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      clientEventId: randomUUID(),
      prompt: "issue a real Zero token for the rollout probe",
    },
    [201],
  );
  if (source.status !== 201) {
    throw new Error("Expected the source prompt to be accepted");
  }
  if (!source.body.runId) {
    throw new Error("Expected the source run to launch");
  }
  await api.heartbeatRunner(runnerGroup);
  const sourceClaim = await api.claimRunnerJob(source.body.runId);
  const zeroToken = sourceClaim.environment?.ZERO_TOKEN;
  if (!zeroToken || !zeroToken.startsWith("vm0_sandbox_")) {
    throw new Error("Expected a real run-scoped Zero token");
  }

  const target = await chat.createThread(actor, {
    agentId: agent.agentId,
  });
  const targetEventId = randomUUID();
  const delegated = await accept(
    setupApp({ context, routes: zeroChatEventsRoutes })(
      chatEventsContract,
    ).send({
      headers: { authorization: `Bearer ${zeroToken}` },
      body: {
        agentId: agent.agentId,
        clientEventId: targetEventId,
        threadId: target.id,
        prompt: "pre-migration delegated prompt",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "pre-migration delegated prompt" }],
        },
      },
    }),
    [201],
  );
  if (delegated.status !== 201) {
    throw new Error("Expected the delegated prompt to be accepted");
  }
  if (!delegated.body.runId) {
    throw new Error("Expected the delegated prompt to launch");
  }
  const delegatedRunId = delegated.body.runId;

  const events = await chat.listThreadEvents(actor, target.id);
  const delegatedEvent = events.events.find((event) => {
    return event.id === targetEventId;
  });
  expect(delegatedEvent).toMatchObject({
    eventType: "input.prompt",
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "pre-migration delegated prompt" }],
    },
  });
  if (delegatedEvent?.eventType !== "input.prompt") {
    throw new Error("Expected the delegated input event");
  }
  expect(delegatedEvent.userMessage.parts).toStrictEqual([
    { type: "text", text: "pre-migration delegated prompt" },
  ]);

  // Production cannot synthesize a historical schema. This isolated
  // database query is the migration-boundary assertion that the normal
  // route left the polymorphic context pointer empty without migration
  // the agent-run context migration or its source-context table. The client
  // event is the visible origin; normal send appends a separate run-associated
  // replacement, so the two persisted facts are related by their canonical
  // thread here.
  const storageRows = await withDatabaseClient(
    preMigrationUrl,
    async (storage) => {
      const result = await storage.query<{
        readonly context_id: string | null;
        readonly context_type: string | null;
        readonly trigger_source: string | null;
      }>(
        `SELECT chat_events.context_id,
                chat_events.context_type,
                zero_runs.trigger_source
         FROM chat_events
         INNER JOIN zero_runs
           ON zero_runs.chat_thread_id = chat_events.chat_thread_id
         WHERE zero_runs.id = $1 AND chat_events.id = $2`,
        [delegatedRunId, targetEventId],
      );
      return result.rows;
    },
  );
  expect(storageRows).toStrictEqual([
    { context_id: null, context_type: null, trigger_source: "agent" },
  ]);
}

async function cleanupPreAgentRunContextRouteProbe(
  originalDatabaseUrl: string,
  databaseName: string,
): Promise<void> {
  await resetDatabasePool(context);
  mockEnv("DATABASE_URL", originalDatabaseUrl);
  await dropDatabase(originalDatabaseUrl, databaseName);
}

describe("chat agent-run context rollout compatibility", () => {
  it("routes an agent prompt safely against an isolated pre-agent-run-context schema", async () => {
    await expect(
      readChatAgentRunContextSchemaAvailable(context),
    ).resolves.toBeTruthy();

    const originalDatabaseUrl = env("DATABASE_URL");
    const databaseName = `vm0_agent_context_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    await onRejection(
      runPreAgentRunContextRouteProbe(originalDatabaseUrl, databaseName),
      () => {
        return cleanupPreAgentRunContextRouteProbe(
          originalDatabaseUrl,
          databaseName,
        );
      },
    );
    await cleanupPreAgentRunContextRouteProbe(
      originalDatabaseUrl,
      databaseName,
    );
  }, 90_000);
});
