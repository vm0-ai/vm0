import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { sql } from "drizzle-orm";
import { HttpResponse, delay, http, passthrough } from "msw";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { bench } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";

import { mockEnv } from "../../../lib/env";
import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import {
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "../__tests__/helpers/zero-chat-threads";
import { seedUserModelProvider$ } from "../__tests__/helpers/zero-model-providers";
import { seedOrgMembership$ } from "../__tests__/helpers/zero-org-membership";
import { createZeroRouteMocks } from "../__tests__/helpers/zero-route-test";

// HTTP-level benchmarks for side-effect-free GET routes that showed elevated
// P90 in production traces. All cases share one seeded DB fixture and only issue
// GET requests during benchmark iterations, so samples do not mutate state or
// require resetting the database between cases.
//
// Fixture seeding runs lazily inside the first bench iteration (not in
// `beforeAll`) because vitest 4 does not bridge `beforeAll` into bench mode:
// iterations would otherwise see an unseeded DB, error silently in
// tinybench, and produce empty samples without failing the suite.
//
// The fixture bulks up zero_runs / agent_runs / chat_messages and the
// user-visible GET data sets well past planner cross-over so Postgres uses the
// same index-driven paths production hits. With tiny fixtures the planner picks
// seq scans and the per-query overhead this bench needs to measure disappears.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const TARGET_RUN_COUNT = 200;
const TARGET_MESSAGES_PER_RUN = 3;
const TARGET_LIST_THREAD_COUNT = 120;
const BACKGROUND_THREAD_COUNT = 200;
const BACKGROUND_RUNS_PER_THREAD = 50;
const BULK_INSERT_CHUNK = 500;
const TARGET_ATTACHMENT_COUNT = 6;
const MOCK_R2_LIST_DELAY_MS = 10;
const STATUSES = ["completed", "completed", "failed", "running"] as const;

const chatThreadClient = setupApp({ context })(chatThreadByIdContract);
const chatThreadsClient = setupApp({ context })(chatThreadsContract);
const chatThreadMessagesClient = setupApp({ context })(
  chatThreadMessagesContract,
);
const connectorsClient = setupApp({ context })(zeroConnectorsMainContract);
const userPreferencesClient = setupApp({ context })(
  zeroUserPreferencesContract,
);
const billingStatusClient = setupApp({ context })(zeroBillingStatusContract);
const orgClient = setupApp({ context })(zeroOrgContract);
const personalModelProvidersClient = setupApp({ context })(
  zeroPersonalModelProvidersMainContract,
);

async function chunkedInsert<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BULK_INSERT_CHUNK) {
    await insert(rows.slice(i, i + BULK_INSERT_CHUNK));
  }
}

function markdownLorem(runIndex: number, messageIndex: number): string {
  const blocks = [
    `# Benchmark note ${String(runIndex)}.${String(messageIndex)}`,
    "This paragraph intentionally uses markdown-shaped content so response serialization has production-like payload weight.",
    "## Observations",
    "- The endpoint should parse and return repeated chat messages.",
    "- Inline code such as `pnpm -F api bench` should remain plain text.",
    "- Links like [docs](https://example.com/docs) should not trigger network work.",
    "",
    "```ts",
    `const sample = { run: ${String(runIndex)}, message: ${String(messageIndex)}, ok: true };`,
    "console.log(sample);",
    "```",
    "",
    "> Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "",
  ];
  return blocks.join("\n").repeat(6);
}

function targetAttachmentId(index: number): string {
  return `bench-attachment-${String(index).padStart(2, "0")}`;
}

function commandName(command: unknown): string {
  return command instanceof Object && "constructor" in command
    ? command.constructor.name
    : "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null
  ) {
    return {};
  }
  return command.input as Record<string, unknown>;
}

function installR2ListMock(): void {
  mockEnv("S3_FORCE_PATH_STYLE", "true");
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (commandName(command) !== "ListObjectsV2Command") {
      return {};
    }

    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
    if (bucket !== "test-user-artifacts") {
      return {};
    }

    await delay(MOCK_R2_LIST_DELAY_MS);
    return {
      Contents: [
        {
          Key: `${prefix}bench-attachment.md`,
          LastModified: new Date("2026-05-25T00:00:00.000Z"),
          Size: 4096,
        },
      ],
    };
  });
  server.use(
    http.get("*", async ({ request }) => {
      const url = new URL(request.url);
      if (!url.hostname.endsWith(".r2.cloudflarestorage.com")) {
        return passthrough();
      }
      const pathBucket = url.pathname.split("/").filter(Boolean)[0];
      const hostBucket = url.hostname.split(".")[0];
      const bucket = pathBucket ?? hostBucket;
      if (
        bucket !== "test-user-artifacts" ||
        url.searchParams.get("list-type") !== "2"
      ) {
        return HttpResponse.text("not found", { status: 404 });
      }

      await delay(MOCK_R2_LIST_DELAY_MS);
      const prefix = url.searchParams.get("prefix") ?? "";
      return HttpResponse.xml(
        `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>test-user-artifacts</Name>
  <Prefix>${prefix}</Prefix>
  <KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>${prefix}bench-attachment.md</Key>
    <LastModified>2026-05-25T00:00:00.000Z</LastModified>
    <ETag>"bench-etag"</ETag>
    <Size>4096</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`,
      );
    }),
  );
}

async function seedBackgroundLoad(): Promise<void> {
  const db = store.set(writeDb$);
  const bgUserId = `bg_user_${randomUUID()}`;
  const bgOrgId = `bg_org_${randomUUID()}`;
  const bgComposeId = randomUUID();
  const bgVersionId = randomUUID();

  await db.insert(agentComposes).values({
    id: bgComposeId,
    userId: bgUserId,
    orgId: bgOrgId,
    name: "bench-bg",
  });
  await db.insert(zeroAgents).values({
    id: bgComposeId,
    orgId: bgOrgId,
    owner: bgUserId,
    name: "bench-bg",
  });
  await db.insert(agentComposeVersions).values({
    id: bgVersionId,
    composeId: bgComposeId,
    content: { version: "1.0", agents: {} },
    createdBy: bgUserId,
  });

  const threadIds: string[] = [];
  const sessionIds: string[] = [];
  for (let i = 0; i < BACKGROUND_THREAD_COUNT; i++) {
    threadIds.push(randomUUID());
    sessionIds.push(randomUUID());
  }

  await chunkedInsert(
    threadIds.map((id) => {
      return {
        id,
        userId: bgUserId,
        agentComposeId: bgComposeId,
        title: "bg",
      };
    }),
    (chunk) => {
      return db.insert(chatThreads).values(chunk);
    },
  );
  await chunkedInsert(
    sessionIds.map((id) => {
      return {
        id,
        userId: bgUserId,
        orgId: bgOrgId,
        agentComposeId: bgComposeId,
      };
    }),
    (chunk) => {
      return db.insert(agentSessions).values(chunk);
    },
  );

  const runRows: {
    id: string;
    userId: string;
    orgId: string;
    agentComposeVersionId: string;
    sessionId: string;
    status: string;
    prompt: string;
  }[] = [];
  const zRunRows: {
    id: string;
    triggerSource: string;
    chatThreadId: string;
  }[] = [];
  for (let t = 0; t < BACKGROUND_THREAD_COUNT; t++) {
    for (let r = 0; r < BACKGROUND_RUNS_PER_THREAD; r++) {
      const runId = randomUUID();
      runRows.push({
        id: runId,
        userId: bgUserId,
        orgId: bgOrgId,
        agentComposeVersionId: bgVersionId,
        sessionId: sessionIds[t]!,
        status: STATUSES[r % STATUSES.length]!,
        prompt: "bg",
      });
      zRunRows.push({
        id: runId,
        triggerSource: "cli",
        chatThreadId: threadIds[t]!,
      });
    }
  }
  await chunkedInsert(runRows, (chunk) => {
    return db.insert(agentRuns).values(chunk);
  });
  await chunkedInsert(zRunRows, (chunk) => {
    return db.insert(zeroRuns).values(chunk);
  });
}

async function seedTargetThreadRuns(
  fixture: ZeroChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  const versionId = randomUUID();
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: fixture.composeId,
    content: { version: "1.0", agents: {} },
    createdBy: fixture.userId,
  });

  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("target session insert returned no row");
  }

  const runRows: {
    id: string;
    userId: string;
    orgId: string;
    agentComposeVersionId: string;
    sessionId: string;
    status: string;
    prompt: string;
  }[] = [];
  const zRunRows: {
    id: string;
    triggerSource: string;
    chatThreadId: string;
  }[] = [];
  const messageRows: {
    chatThreadId: string;
    runId: string;
    role: string;
    content: string;
    sequenceNumber: number;
    attachFiles?: string[];
    createdAt: Date;
  }[] = [];
  const now = nowDate().getTime();
  for (let i = 0; i < TARGET_RUN_COUNT; i++) {
    const runId = randomUUID();
    runRows.push({
      id: runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeVersionId: versionId,
      sessionId: session.id,
      status: STATUSES[i % STATUSES.length]!,
      prompt: `bench prompt ${String(i)}`,
    });
    zRunRows.push({
      id: runId,
      triggerSource: "cli",
      chatThreadId: fixture.threadId,
    });
    for (let m = 0; m < TARGET_MESSAGES_PER_RUN; m++) {
      const latestAttachmentStart = TARGET_RUN_COUNT - TARGET_ATTACHMENT_COUNT;
      messageRows.push({
        chatThreadId: fixture.threadId,
        runId,
        role: m === 0 ? "user" : "assistant",
        content: markdownLorem(i, m),
        sequenceNumber: m,
        ...(m === 0 && i >= latestAttachmentStart
          ? { attachFiles: [targetAttachmentId(i - latestAttachmentStart)] }
          : {}),
        createdAt: new Date(now + i * 1000 + m),
      });
    }
  }
  await chunkedInsert(runRows, (chunk) => {
    return db.insert(agentRuns).values(chunk);
  });
  await chunkedInsert(zRunRows, (chunk) => {
    return db.insert(zeroRuns).values(chunk);
  });
  await chunkedInsert(messageRows, (chunk) => {
    return db.insert(chatMessages).values(chunk);
  });
}

async function seedTargetThreadListRows(
  fixture: ZeroChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  const now = nowDate().getTime();
  const threadRows: {
    id: string;
    userId: string;
    agentComposeId: string;
    title: string;
    lastMessageAt: Date;
    createdAt: Date;
    updatedAt: Date;
    pinnedAt?: Date;
  }[] = [];
  const messageRows: {
    chatThreadId: string;
    role: string;
    content: string;
    createdAt: Date;
  }[] = [];

  for (let i = 0; i < TARGET_LIST_THREAD_COUNT; i++) {
    const createdAt = new Date(now - i * 1000);
    const id = randomUUID();
    threadRows.push({
      id,
      userId: fixture.userId,
      agentComposeId: fixture.composeId,
      title: `bench-list-${String(i)}`,
      lastMessageAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      ...(i < 5 ? { pinnedAt: createdAt } : {}),
    });
    messageRows.push({
      chatThreadId: id,
      role: "user",
      content: `bench list message ${String(i)}`,
      createdAt,
    });
  }

  await chunkedInsert(threadRows, (chunk) => {
    return db.insert(chatThreads).values(chunk);
  });
  await chunkedInsert(messageRows, (chunk) => {
    return db.insert(chatMessages).values(chunk);
  });
}

async function seedSideEffectFreeGetData(
  fixture: ZeroChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);

  await store.set(
    seedOrgMembership$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
      slug: "bench-api",
      name: "Bench API",
    },
    context.signal,
  );

  await db.insert(orgMetadata).values({
    orgId: fixture.orgId,
    credits: 125_000,
    tier: "pro",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    subscriptionStatus: "active",
    currentPeriodEnd: new Date("2099-01-01T00:00:00.000Z"),
  });
  await db.insert(creditExpiresRecord).values({
    orgId: fixture.orgId,
    source: "subscription_renewal",
    amount: 20_000,
    remaining: 18_000,
    expiresAt: new Date("2099-02-01T00:00:00.000Z"),
    stripeInvoiceId: `inv_${randomUUID()}`,
  });
  await db.insert(orgMembersMetadata).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    timezone: "America/Los_Angeles",
    pinnedAgentIds: [fixture.composeId],
    sendMode: "cmd-enter",
    captureNetworkBodiesRemaining: 3,
  });
  await db.insert(connectors).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "github",
      authMethod: "oauth",
      externalId: "bench-github",
      externalUsername: "bench-github",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "slack",
      authMethod: "oauth",
      externalId: "bench-slack",
      externalUsername: "bench-slack",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "notion",
      authMethod: "oauth",
      externalId: "bench-notion",
      externalUsername: "bench-notion",
    },
  ]);

  await store.set(
    seedUserModelProvider$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "codex-oauth-token",
      isDefault: true,
      secretName: "CODEX_OAUTH_TOKEN",
    },
    context.signal,
  );
  await store.set(
    seedUserModelProvider$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "claude-code-oauth-token",
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    },
    context.signal,
  );
  await seedTargetThreadListRows(fixture);
}

async function logPlannerDiagnostic(
  fixture: ZeroChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.execute(sql`
    ANALYZE
      zero_runs,
      agent_runs,
      chat_threads,
      chat_messages,
      connectors,
      org_metadata,
      org_members_metadata,
      model_providers,
      credit_expires_record
  `);
  const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT zero_runs.id, agent_runs.status
    FROM zero_runs
    INNER JOIN agent_runs ON zero_runs.id = agent_runs.id
    WHERE zero_runs.chat_thread_id = ${fixture.threadId}
  `);
  const lines = plan.rows.map((row) => {
    return row["QUERY PLAN"];
  });
  process.stdout.write(
    `\n[bench-explain] zero_runs JOIN agent_runs WHERE chat_thread_id\n${lines.join("\n")}\n\n`,
  );
}

const ensureSeeded: () => Promise<ZeroChatThreadFixture> = (() => {
  let cached: Promise<ZeroChatThreadFixture> | undefined;
  return () => {
    cached ??= (async () => {
      installR2ListMock();
      const seeded = await store.set(
        seedZeroChatThread$,
        { title: "bench" },
        context.signal,
      );
      await seedBackgroundLoad();
      await seedTargetThreadRuns(seeded);
      await seedSideEffectFreeGetData(seeded);
      await logPlannerDiagnostic(seeded);

      mocks.clerk.session(seeded.userId, seeded.orgId);
      const sanity = await chatThreadClient.get({
        params: { id: seeded.threadId },
        headers: { authorization: "Bearer clerk-session" },
      });
      if (sanity.status !== 200) {
        throw new Error(
          `sanity check failed: status=${String(sanity.status)} body=${JSON.stringify(sanity.body)}`,
        );
      }
      return seeded;
    })();
    return cached;
  };
})();

const benchOptions = { time: 5000, warmupIterations: 5, throws: true } as const;
const authHeaders = { authorization: "Bearer clerk-session" } as const;

describe("bench side-effect-free GET API routes", () => {
  bench(
    "GET /api/zero/chat-threads/:id",
    async () => {
      const fixture = await ensureSeeded();
      const response = await chatThreadClient.get({
        params: { id: fixture.threadId },
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/chat-threads",
    async () => {
      await ensureSeeded();
      const response = await chatThreadsClient.list({
        query: { limit: 50 },
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/chat-threads/:threadId/messages",
    async () => {
      const fixture = await ensureSeeded();
      const response = await chatThreadMessagesClient.list({
        params: { threadId: fixture.threadId },
        query: { limit: 50 },
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/connectors",
    async () => {
      await ensureSeeded();
      const response = await connectorsClient.list({ headers: authHeaders });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/user-preferences",
    async () => {
      await ensureSeeded();
      const response = await userPreferencesClient.get({
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/billing/status",
    async () => {
      await ensureSeeded();
      const response = await billingStatusClient.get({ headers: authHeaders });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/org",
    async () => {
      await ensureSeeded();
      const response = await orgClient.get({ headers: authHeaders });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );

  bench(
    "GET /api/zero/me/model-providers",
    async () => {
      await ensureSeeded();
      const response = await personalModelProvidersClient.list({
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    benchOptions,
  );
});
