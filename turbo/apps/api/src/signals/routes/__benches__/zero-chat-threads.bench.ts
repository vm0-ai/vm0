import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { sql } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { bench } from "vitest";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";

import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "../__tests__/helpers/zero-chat-threads";
import { createZeroRouteMocks } from "../__tests__/helpers/zero-route-test";

// HTTP-level benchmark for GET /api/zero/chat-threads/:id. The handler currently
// issues 4 nearly identical `zero_runs INNER JOIN agent_runs` queries; this
// bench establishes the baseline so a follow-up refactor (merge into 1 query)
// can be measured against it via CI artifact diff.
//
// Fixture seeding runs lazily inside the first bench iteration (not in
// `beforeAll`) because vitest 4 does not bridge `beforeAll` into bench mode:
// iterations would otherwise see an unseeded DB, error silently in
// tinybench, and produce empty samples without failing the suite.
//
// The fixture bulks up zero_runs / agent_runs / chat_messages well past
// planner cross-over (~10k background rows + 200 rows on the target thread)
// so Postgres uses the chat_thread_id index scan that production hits.
// With only ~50 rows total the planner picks a seq scan and the per-query
// overhead — the very cost this bench needs to measure — disappears.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const TARGET_RUN_COUNT = 200;
const TARGET_MESSAGES_PER_RUN = 3;
const BACKGROUND_THREAD_COUNT = 200;
const BACKGROUND_RUNS_PER_THREAD = 50;
const BULK_INSERT_CHUNK = 500;
const STATUSES = ["completed", "completed", "failed", "running"] as const;

const client = setupApp({ context })(chatThreadByIdContract);

async function chunkedInsert<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BULK_INSERT_CHUNK) {
    await insert(rows.slice(i, i + BULK_INSERT_CHUNK));
  }
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
  }[] = [];
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
      messageRows.push({
        chatThreadId: fixture.threadId,
        runId,
        role: m === 0 ? "user" : "assistant",
        content: `message ${String(i)}-${String(m)}`,
        sequenceNumber: m,
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

async function logPlannerDiagnostic(
  fixture: ZeroChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.execute(sql`ANALYZE zero_runs, agent_runs, chat_messages`);
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
      const seeded = await store.set(
        seedZeroChatThread$,
        { title: "bench" },
        context.signal,
      );
      await seedBackgroundLoad();
      await seedTargetThreadRuns(seeded);
      await logPlannerDiagnostic(seeded);

      mocks.clerk.session(seeded.userId, seeded.orgId);
      const sanity = await client.get({
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

describe("bench GET /api/zero/chat-threads/:id", () => {
  bench(
    "current",
    async () => {
      const fixture = await ensureSeeded();
      const response = await client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    { time: 5000, warmupIterations: 5 },
  );
});
