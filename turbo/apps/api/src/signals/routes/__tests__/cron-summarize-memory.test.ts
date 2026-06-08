import { randomUUID } from "node:crypto";

import { cronSummarizeMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { memoryChangeItems } from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { storageVersions } from "@vm0/db/schema/storage";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  deleteMemoryForFixture$,
  findMemoryStorageId$,
  type MemoryFixture,
  mockMemoryVersions,
  seedMemoryFixture$,
  seedMemoryStorage$,
  seedMemoryVersion$,
} from "./helpers/zero-memory";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Fixed clock: "today" in UTC is 2999-01-03, so the seven most-recently-closed
// local days are 2998-12-27 through 2999-01-02.
const FIXED_NOW_ISO = "2999-01-03T12:00:00.000Z";
const LOOKBACK_DATES = [
  "2998-12-27",
  "2998-12-28",
  "2998-12-29",
  "2998-12-30",
  "2998-12-31",
  "2999-01-01",
  "2999-01-02",
] as const;
const BASELINE_BEFORE_LOOKBACK = "2998-12-26T03:00:00.000Z";
const BASELINE_DURING_LOOKBACK = "2999-01-01T03:00:00.000Z";
const YESTERDAY = "2999-01-02";

interface OpenRouterRequestMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenRouterRequestBody {
  readonly model: string;
  readonly messages: readonly OpenRouterRequestMessage[];
  readonly max_tokens?: number;
}

/**
 * Enable the Memory Viewer feature for a fixture's org/user. The cron only
 * processes users who can see the Memory page; fixtures use random org IDs that
 * do not match the staff-org rollout, so tests opt in via a DB override exactly
 * as the platform's per-user feature-switch overrides do.
 */
async function enableMemoryViewer(fixture: MemoryFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(userFeatureSwitches)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.MemoryViewer]: true },
    })
    .onConflictDoNothing();
}

const track = createFixtureTracker<MemoryFixture>(async (fixture) => {
  await store.set(deleteMemoryForFixture$, fixture, context.signal);
  const db = store.set(writeDb$);
  await db
    .delete(userFeatureSwitches)
    .where(eq(userFeatureSwitches.orgId, fixture.orgId));
});

function apiClient() {
  return setupApp({ context })(cronSummarizeMemoryContract);
}

function devRefreshClient() {
  return setupApp({ context })(zeroMemoryDevRefreshContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/cron/summarize-memory", {
    method: "GET",
    headers,
  });
}

interface MemoryFile {
  readonly path: string;
  readonly content: string;
}

interface SeededMemory {
  readonly fixture: MemoryFixture;
  readonly v2Id: string;
}

/**
 * Seed a memory artifact whose baseline (v1) predates the seven-day lookback
 * window and whose v2 lands during yesterday. The first cron run backfills six
 * quiet cards and yesterday's v1 -> v2 diff.
 */
async function seedTwoVersions(
  files1: readonly MemoryFile[],
  files2: readonly MemoryFile[],
): Promise<SeededMemory> {
  const fixture = await track(
    store.set(seedMemoryFixture$, undefined, context.signal),
  );
  await enableMemoryViewer(fixture);
  const base = `orgs/${fixture.orgId}/users/${fixture.userId}/memory`;
  const v1Key = `${base}/v1`;
  const v2Key = `${base}/v2`;
  const v1Id = `v1-${randomUUID()}`;
  const v2Id = `v2-${randomUUID()}`;

  await store.set(
    seedMemoryStorage$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      s3Key: v1Key,
      headVersionId: v1Id,
      fileCount: files1.length,
      updatedAt: new Date(BASELINE_BEFORE_LOOKBACK),
    },
    context.signal,
  );

  const storageId = await store.set(
    findMemoryStorageId$,
    fixture.orgId,
    context.signal,
  );
  // Re-stamp the head version (v1) before the lookback window so it is the
  // baseline for every backfilled day, not an implicit wall-clock now.
  const db = store.set(writeDb$);
  await db
    .update(storageVersions)
    .set({ createdAt: new Date(BASELINE_BEFORE_LOOKBACK) })
    .where(eq(storageVersions.id, v1Id));
  await store.set(
    seedMemoryVersion$,
    {
      storageId,
      versionId: v2Id,
      s3Key: v2Key,
      userId: fixture.userId,
      createdAt: new Date("2999-01-02T09:00:00.000Z"),
    },
    context.signal,
  );

  mockMemoryVersions(context, [
    { s3Key: v1Key, files: files1 },
    { s3Key: v2Key, files: files2 },
  ]);

  return { fixture, v2Id };
}

/**
 * Seed two versions for a user inside the lookback window without mocking S3
 * content. The caller supplies a single combined S3 mock (so several users can
 * coexist on the shared mock), and may deliberately omit a user's content to
 * make their per-user summarize throw — exercising the cron's per-user error
 * isolation.
 */
async function seedTwoVersionsNoMock(): Promise<{
  fixture: MemoryFixture;
  v1Key: string;
  v2Key: string;
  v2Id: string;
}> {
  const fixture = await track(
    store.set(seedMemoryFixture$, undefined, context.signal),
  );
  await enableMemoryViewer(fixture);
  const base = `orgs/${fixture.orgId}/users/${fixture.userId}/memory`;
  const v1Key = `${base}/v1`;
  const v2Key = `${base}/v2`;
  const v1Id = `v1-${randomUUID()}`;
  const v2Id = `v2-${randomUUID()}`;

  await store.set(
    seedMemoryStorage$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      s3Key: v1Key,
      headVersionId: v1Id,
      fileCount: 1,
      updatedAt: new Date(BASELINE_DURING_LOOKBACK),
    },
    context.signal,
  );

  const storageId = await store.set(
    findMemoryStorageId$,
    fixture.orgId,
    context.signal,
  );
  // v1 appears during the lookback window; v2 lands during yesterday.
  const db = store.set(writeDb$);
  await db
    .update(storageVersions)
    .set({ createdAt: new Date(BASELINE_DURING_LOOKBACK) })
    .where(eq(storageVersions.id, v1Id));
  await store.set(
    seedMemoryVersion$,
    {
      storageId,
      versionId: v2Id,
      s3Key: v2Key,
      userId: fixture.userId,
      createdAt: new Date("2999-01-02T09:00:00.000Z"),
    },
    context.signal,
  );

  return { fixture, v1Key, v2Key, v2Id };
}

interface DayVersion {
  readonly createdAt: Date;
  readonly files: readonly MemoryFile[];
}

/**
 * Seed a memory artifact with an arbitrary number of versions spread across
 * several days, mock their S3 content, and register the fixture for cleanup.
 * The first version establishes the baseline; each later version is that
 * version's net memory state at its createdAt.
 */
async function seedVersions(versions: readonly DayVersion[]): Promise<{
  fixture: MemoryFixture;
}> {
  const fixture = await track(
    store.set(seedMemoryFixture$, undefined, context.signal),
  );
  await enableMemoryViewer(fixture);
  const base = `orgs/${fixture.orgId}/users/${fixture.userId}/memory`;
  const [first, ...rest] = versions;
  if (!first) {
    throw new Error("seedVersions requires at least one version");
  }

  const firstKey = `${base}/v1`;
  const firstId = `v1-${randomUUID()}`;
  await store.set(
    seedMemoryStorage$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      s3Key: firstKey,
      headVersionId: firstId,
      fileCount: first.files.length,
      updatedAt: first.createdAt,
    },
    context.signal,
  );

  const storageId = await store.set(
    findMemoryStorageId$,
    fixture.orgId,
    context.signal,
  );
  // Stamp the first version to its intended createdAt (the storage head
  // version otherwise defaults to wall-clock now) so day boundaries are exact.
  const db = store.set(writeDb$);
  await db
    .update(storageVersions)
    .set({ createdAt: first.createdAt })
    .where(eq(storageVersions.id, firstId));

  const content: { s3Key: string; files: readonly MemoryFile[] }[] = [
    { s3Key: firstKey, files: first.files },
  ];
  let index = 2;
  for (const version of rest) {
    const key = `${base}/v${index}`;
    await store.set(
      seedMemoryVersion$,
      {
        storageId,
        versionId: `v${index}-${randomUUID()}`,
        s3Key: key,
        userId: fixture.userId,
        createdAt: version.createdAt,
      },
      context.signal,
    );
    content.push({ s3Key: key, files: version.files });
    index++;
  }

  mockMemoryVersions(context, content);

  return { fixture };
}

async function findSummary(
  fixture: MemoryFixture,
  date = YESTERDAY,
): Promise<{
  id: string;
  date: string;
  fromVersionId: string | null;
  toVersionId: string;
  summary: string | null;
} | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      id: memoryChangeSummaries.id,
      date: memoryChangeSummaries.date,
      fromVersionId: memoryChangeSummaries.fromVersionId,
      toVersionId: memoryChangeSummaries.toVersionId,
      summary: memoryChangeSummaries.summary,
    })
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, fixture.orgId),
        eq(memoryChangeSummaries.userId, fixture.userId),
        eq(memoryChangeSummaries.date, date),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findSummaries(fixture: MemoryFixture): Promise<
  {
    readonly id: string;
    readonly date: string;
    readonly fromVersionId: string | null;
    readonly toVersionId: string;
    readonly summary: string | null;
  }[]
> {
  const db = store.set(writeDb$);
  return await db
    .select({
      id: memoryChangeSummaries.id,
      date: memoryChangeSummaries.date,
      fromVersionId: memoryChangeSummaries.fromVersionId,
      toVersionId: memoryChangeSummaries.toVersionId,
      summary: memoryChangeSummaries.summary,
    })
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, fixture.orgId),
        eq(memoryChangeSummaries.userId, fixture.userId),
      ),
    )
    .orderBy(asc(memoryChangeSummaries.date));
}

async function findItems(summaryId: string): Promise<string[]> {
  const db = store.set(writeDb$);
  const rows = await db
    .select({
      filePath: memoryChangeItems.filePath,
    })
    .from(memoryChangeItems)
    .where(eq(memoryChangeItems.summaryId, summaryId))
    .orderBy(asc(memoryChangeItems.filePath));
  return rows.map((row) => {
    return row.filePath;
  });
}

function mockLlm(
  content = "Today Zero learned one new thing about you.",
  finishReason = "stop",
): {
  calls: number;
  requests: OpenRouterRequestBody[];
} {
  const state: { calls: number; requests: OpenRouterRequestBody[] } = {
    calls: 0,
    requests: [],
  };
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      state.calls++;
      state.requests.push((await request.json()) as OpenRouterRequestBody);
      return HttpResponse.json({
        choices: [{ finish_reason: finishReason, message: { content } }],
      });
    }),
  );
  return state;
}

describe("GET /api/cron/summarize-memory", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().summarize({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with a missing authorization header", async () => {
    const response = await rawCronRequest();
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("returns skipped when there are no memory artifacts", async () => {
    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual({ skipped: true });
  });

  it("backfills seven closed days and summarizes the changed day with an LLM narrative", async () => {
    const llm = mockLlm(
      "Zero learned your coffee order and updated your pets.",
    );
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [
        { path: "facts/pets.md", content: "Has a dog and a cat" },
        { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
      ],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    expect(llm.calls).toBe(1);
    expect(llm.requests[0]).toMatchObject({
      model: "google/gemini-3.5-flash",
    });
    expect(llm.requests[0]).not.toHaveProperty("max_tokens");
    const systemMessage = llm.requests[0]?.messages.find((message) => {
      return message.role === "system";
    })?.content;
    expect(systemMessage).toContain("**Changed memory**");
    expect(systemMessage).toContain("**How Zero will use this**");
    expect(systemMessage).toContain('Always refer to the agent as "Zero"');
    expect(systemMessage).toContain("Do not use first person");
    expect(systemMessage).toContain(
      'Phrase natural memory changes in third person with "Zero" as the subject',
    );
    expect(systemMessage).toContain(
      "Never phrase a memory update as if Zero is speaking",
    );
    expect(systemMessage).toContain(
      "Never say or imply that Zero modified, deleted, created, consulted, or will no longer consult memory files",
    );
    const userMessage = llm.requests[0]?.messages.find((message) => {
      return message.role === "user";
    })?.content;
    expect(userMessage).toContain("Internal memory diffs today");
    expect(userMessage).toContain(
      "Internal source path (do not mention): facts/coffee.md",
    );
    expect(userMessage).toContain(
      "Internal storage operation (do not mention): added",
    );
    expect(userMessage).toContain("+ Drinks oat milk lattes");
    expect(userMessage).toContain(
      "Internal source path (do not mention): facts/pets.md",
    );
    expect(userMessage).toContain(
      "Internal storage operation (do not mention): modified",
    );
    expect(userMessage).toContain("- Has a dog");
    expect(userMessage).toContain("+ Has a dog and a cat");
    expect(userMessage).not.toContain("Learned:");

    const summaries = await findSummaries(seeded.fixture);
    expect(
      summaries.map((row) => {
        return row.date;
      }),
    ).toStrictEqual([...LOOKBACK_DATES]);
    for (const quietSummary of summaries.slice(0, -1)) {
      await expect(findItems(quietSummary.id)).resolves.toHaveLength(0);
      expect(quietSummary.summary).toBeNull();
    }

    const summary = await findSummary(seeded.fixture);
    expect(summary).not.toBeNull();
    expect(summary?.toVersionId).toBe(seeded.v2Id);
    expect(summary?.summary).toBe(
      "Zero learned your coffee order and updated your pets.",
    );

    const items = await findItems(summary?.id ?? "");
    expect(items).toStrictEqual(["facts/coffee.md", "facts/pets.md"]);
  });

  it("summarizes a file whose frontmatter is not valid YAML", async () => {
    // Regression for the prod 500: a memory file whose `description` opens with
    // a backtick is invalid YAML and made parseSkillFrontmatter throw a
    // YAMLParseError, which propagated up and 500'd every cron run. Memory
    // activity diffs no longer parse frontmatter, so the run must complete and
    // persist the changed file.
    const llm = mockLlm();
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [
        { path: "facts/pets.md", content: "Has a dog" },
        {
          path: "facts/zero-search.md",
          content:
            "---\nname: zero search\ndescription: `zero search` command shipped in CLI v9.125.x\n---\nbody",
        },
      ],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    expect(llm.calls).toBe(1);

    const summary = await findSummary(seeded.fixture);
    const items = await findItems(summary?.id ?? "");
    expect(items).toStrictEqual(["facts/zero-search.md"]);
  });

  it("persists MEMORY.md alongside the real file change", async () => {
    mockLlm();
    const seeded = await seedTwoVersions(
      [{ path: "MEMORY.md", content: "# index v1" }],
      [
        { path: "MEMORY.md", content: "# index v2" },
        { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
      ],
    );

    await accept(apiClient().summarize({ headers: cronHeaders() }), [200]);

    const summary = await findSummary(seeded.fixture);
    const items = await findItems(summary?.id ?? "");
    expect(items).toHaveLength(2);
    expect(items).toContain("MEMORY.md");
    expect(items).toContain("facts/coffee.md");
  });

  it("backfills quiet cards and makes no LLM call when memory did not change", async () => {
    const llm = mockLlm();
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [{ path: "facts/pets.md", content: "Has a dog" }],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    expect(llm.calls).toBe(0);
    const summaries = await findSummaries(seeded.fixture);
    expect(
      summaries.map((row) => {
        return row.date;
      }),
    ).toStrictEqual([...LOOKBACK_DATES]);
    const summary = await findSummary(seeded.fixture);
    expect(summary?.summary).toBeNull();
    await expect(findItems(summary?.id ?? "")).resolves.toHaveLength(0);
  });

  it("persists deterministic items with a null summary when the LLM fails", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [{ path: "facts/coffee.md", content: "Drinks oat milk lattes" }],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    const summary = await findSummary(seeded.fixture);
    expect(summary?.summary).toBeNull();
    await expect(findItems(summary?.id ?? "")).resolves.toHaveLength(2);
  });

  it("persists deterministic items with a null summary when the LLM response is incomplete", async () => {
    const llm = mockLlm(
      "Zero learned about a runner claim bug followed by a",
      "length",
    );
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [{ path: "facts/coffee.md", content: "Drinks oat milk lattes" }],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    expect(llm.calls).toBe(1);
    const summary = await findSummary(seeded.fixture);
    expect(summary?.summary).toBeNull();
    await expect(findItems(summary?.id ?? "")).resolves.toHaveLength(2);
  });

  it("persists deterministic items with a null summary when no LLM key is configured", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [
        { path: "facts/pets.md", content: "Has a dog" },
        { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
      ],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    const summary = await findSummary(seeded.fixture);
    expect(summary?.summary).toBeNull();
    await expect(findItems(summary?.id ?? "")).resolves.toHaveLength(1);
  });

  it("is idempotent on rerun", async () => {
    mockLlm();
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [
        { path: "facts/pets.md", content: "Has a dog" },
        { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
      ],
    );

    await accept(apiClient().summarize({ headers: cronHeaders() }), [200]);
    const second = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    // The day was already summarized, so the next run advances past it.
    expect(second.body).toStrictEqual({ skipped: true });

    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: memoryChangeSummaries.id })
      .from(memoryChangeSummaries)
      .where(eq(memoryChangeSummaries.orgId, seeded.fixture.orgId));
    expect(rows).toHaveLength(7);
    const summary = await findSummary(seeded.fixture);
    await expect(findItems(summary?.id ?? "")).resolves.toHaveLength(1);
  });

  it("isolates a failing user so others are still summarized", async () => {
    // Defense-in-depth: one user's data error (here, missing S3 content) must
    // not abort the whole run. The healthy user must still be summarized.
    const llm = mockLlm();
    const healthy = await seedTwoVersionsNoMock();
    const broken = await seedTwoVersionsNoMock();

    // Combined mock: only the healthy user's versions resolve. The broken
    // user's keys are absent, so its manifest download throws and its per-user
    // summarize fails — without the isolation that would 500 the whole run.
    mockMemoryVersions(context, [
      {
        s3Key: healthy.v1Key,
        files: [{ path: "facts/pets.md", content: "Has a dog" }],
      },
      {
        s3Key: healthy.v2Key,
        files: [
          { path: "facts/pets.md", content: "Has a dog" },
          { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
        ],
      },
    ]);

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 2 });
    expect(llm.calls).toBe(2);

    const healthySummary = await findSummary(healthy.fixture);
    expect(healthySummary).not.toBeNull();
    expect(healthySummary?.toVersionId).toBe(healthy.v2Id);
    const items = await findItems(healthySummary?.id ?? "");
    expect(items).toStrictEqual(["facts/coffee.md"]);

    await expect(findSummary(broken.fixture)).resolves.toBeNull();
  });

  it("backfills each changed day in the seven-day window without combining history", async () => {
    const llm = mockLlm();
    // A user with months of accumulated memory. The baseline must be the state
    // at the START of yesterday, so the card reflects only the day-over-day
    // change — never the whole history dump that the buggy run produced.
    const { fixture } = await seedVersions([
      {
        // Long ago: three established facts.
        createdAt: new Date("2998-12-30T09:00:00.000Z"),
        files: [
          { path: "facts/a.md", content: "fact a" },
          { path: "facts/b.md", content: "fact b" },
          { path: "facts/c.md", content: "fact c" },
        ],
      },
      {
        // The day before yesterday: a fourth fact lands.
        createdAt: new Date("2999-01-01T09:00:00.000Z"),
        files: [
          { path: "facts/a.md", content: "fact a" },
          { path: "facts/b.md", content: "fact b" },
          { path: "facts/c.md", content: "fact c" },
          { path: "facts/d.md", content: "fact d" },
        ],
      },
      {
        // Yesterday: only `e.md` is new.
        createdAt: new Date("2999-01-02T09:00:00.000Z"),
        files: [
          { path: "facts/a.md", content: "fact a" },
          { path: "facts/b.md", content: "fact b" },
          { path: "facts/c.md", content: "fact c" },
          { path: "facts/d.md", content: "fact d" },
          { path: "facts/e.md", content: "fact e" },
        ],
      },
    ]);

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 4 });
    expect(llm.calls).toBe(3);

    const summaries = await findSummaries(fixture);

    expect(
      summaries.map((row) => {
        return row.date;
      }),
    ).toStrictEqual(["2998-12-30", "2998-12-31", "2999-01-01", YESTERDAY]);
    // The card is the yesterday-only delta: just `e.md`, NOT a,b,c,d.
    await expect(findItems(summaries[0]?.id ?? "")).resolves.toStrictEqual([
      "facts/a.md",
      "facts/b.md",
      "facts/c.md",
    ]);
    await expect(findItems(summaries[1]?.id ?? "")).resolves.toHaveLength(0);
    await expect(findItems(summaries[2]?.id ?? "")).resolves.toStrictEqual([
      "facts/d.md",
    ]);
    await expect(findItems(summaries[3]?.id ?? "")).resolves.toStrictEqual([
      "facts/e.md",
    ]);
  });

  it("treats memory that first appeared yesterday as learned (null baseline)", async () => {
    const llm = mockLlm();
    // The user's very first memory version lands during yesterday — there is no
    // baseline before yesterday's start, so everything is learned yesterday.
    const { fixture } = await seedVersions([
      {
        createdAt: new Date("2999-01-02T09:00:00.000Z"),
        files: [{ path: "facts/coffee.md", content: "Drinks oat milk lattes" }],
      },
    ]);

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 1 });
    expect(llm.calls).toBe(1);

    const summary = await findSummary(fixture);
    expect(summary).not.toBeNull();
    await expect(findItems(summary?.id ?? "")).resolves.toStrictEqual([
      "facts/coffee.md",
    ]);
  });

  it("only summarizes users for whom the memory viewer feature is enabled", async () => {
    const llm = mockLlm();
    // Both users changed memory inside the lookback window. Only the enabled
    // user is processed; the disabled user gets no rows and burns no LLM call.
    // Both share a single combined S3 mock so neither user's content clobbers
    // the other's.
    const enabled = await seedTwoVersionsNoMock();
    const disabled = await seedTwoVersionsNoMock();

    // The disabled user has no feature-switch override, so MemoryViewer is off
    // for their random (non-staff) org.
    const db = store.set(writeDb$);
    await db
      .delete(userFeatureSwitches)
      .where(eq(userFeatureSwitches.orgId, disabled.fixture.orgId));

    mockMemoryVersions(context, [
      {
        s3Key: enabled.v1Key,
        files: [{ path: "facts/pets.md", content: "Has a dog" }],
      },
      {
        s3Key: enabled.v2Key,
        files: [
          { path: "facts/pets.md", content: "Has a dog" },
          { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
        ],
      },
      {
        s3Key: disabled.v1Key,
        files: [{ path: "facts/pets.md", content: "Has a dog" }],
      },
      {
        s3Key: disabled.v2Key,
        files: [
          { path: "facts/pets.md", content: "Has a dog" },
          { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
        ],
      },
    ]);

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 2 });
    expect(llm.calls).toBe(2);

    const enabledSummary = await findSummary(enabled.fixture);
    expect(enabledSummary).not.toBeNull();
    expect(enabledSummary?.toVersionId).toBe(enabled.v2Id);
    await expect(findSummaries(disabled.fixture)).resolves.toHaveLength(0);
  });
});

describe("POST /api/zero/memory/dev-refresh", () => {
  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      devRefreshClient().refresh({ headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects non-staff users outside development", async () => {
    mockEnv("ENV", "production");
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Memory dev refresh is only available to staff",
        code: "FORBIDDEN",
      },
    });
  });

  it("force-regenerates only the current user's memory summaries", async () => {
    const current = await seedTwoVersionsNoMock();
    const other = await seedTwoVersionsNoMock();
    mockMemoryVersions(context, [
      {
        s3Key: current.v1Key,
        files: [{ path: "facts/pets.md", content: "Has a dog" }],
      },
      {
        s3Key: current.v2Key,
        files: [
          { path: "facts/pets.md", content: "Has a dog" },
          { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
        ],
      },
      {
        s3Key: other.v1Key,
        files: [{ path: "facts/pets.md", content: "Has a dog" }],
      },
      {
        s3Key: other.v2Key,
        files: [
          { path: "facts/pets.md", content: "Has a dog" },
          { path: "facts/coffee.md", content: "Drinks oat milk lattes" },
        ],
      },
    ]);
    mocks.clerk.session(current.fixture.userId, current.fixture.orgId);

    const oldLlm = mockLlm("Old prompt summary");
    const first = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [200],
    );
    expect(first.body).toStrictEqual({ summarized: 2 });
    expect(oldLlm.calls).toBe(2);

    const before = await findSummary(current.fixture);
    expect(before?.summary).toBe("Old prompt summary");
    await expect(findSummaries(other.fixture)).resolves.toHaveLength(0);

    const newLlm = mockLlm("New prompt summary");
    const second = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [200],
    );

    expect(second.body).toStrictEqual({ summarized: 2 });
    expect(newLlm.calls).toBe(2);
    const after = await findSummary(current.fixture);
    expect(after?.id).toBe(before?.id);
    expect(after?.summary).toBe("New prompt summary");
    await expect(findSummaries(current.fixture)).resolves.toHaveLength(2);
    await expect(findSummaries(other.fixture)).resolves.toHaveLength(0);
  });
});
