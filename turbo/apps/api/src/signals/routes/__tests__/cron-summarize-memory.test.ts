import { randomUUID } from "node:crypto";

import { cronSummarizeMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { memoryChangeItems } from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
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
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Fixed clock: the closed local (UTC) days before "today" (2999-01-03) are
// 2999-01-01 and 2999-01-02. Single-day tests target 2999-01-02; the multi-day
// backfill test spans both.
const FIXED_NOW_ISO = "2999-01-03T12:00:00.000Z";
const CLOSED_DATE = "2999-01-02";

const track = createFixtureTracker<MemoryFixture>((fixture) => {
  return store.set(deleteMemoryForFixture$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(cronSummarizeMemoryContract);
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
 * Seed a memory artifact with two versions both inside the closed day, mock
 * their S3 content, and register the fixture for cleanup. The first version
 * establishes the baseline; the second version is the day's net result.
 */
async function seedTwoVersions(
  files1: readonly MemoryFile[],
  files2: readonly MemoryFile[],
): Promise<SeededMemory> {
  const fixture = await track(
    store.set(seedMemoryFixture$, undefined, context.signal),
  );
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
      updatedAt: new Date("2999-01-02T03:00:00.000Z"),
    },
    context.signal,
  );

  const storageId = await store.set(
    findMemoryStorageId$,
    fixture.orgId,
    context.signal,
  );
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
  const base = `orgs/${fixture.orgId}/users/${fixture.userId}/memory`;
  const [first, ...rest] = versions;
  if (!first) {
    throw new Error("seedVersions requires at least one version");
  }

  const firstKey = `${base}/v1`;
  await store.set(
    seedMemoryStorage$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      s3Key: firstKey,
      headVersionId: `v1-${randomUUID()}`,
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
): Promise<{ id: string; toVersionId: string; summary: string | null } | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      id: memoryChangeSummaries.id,
      toVersionId: memoryChangeSummaries.toVersionId,
      summary: memoryChangeSummaries.summary,
    })
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, fixture.orgId),
        eq(memoryChangeSummaries.userId, fixture.userId),
        eq(memoryChangeSummaries.date, CLOSED_DATE),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findItems(
  summaryId: string,
): Promise<{ kind: string; filePath: string }[]> {
  const db = store.set(writeDb$);
  return await db
    .select({
      kind: memoryChangeItems.kind,
      filePath: memoryChangeItems.filePath,
    })
    .from(memoryChangeItems)
    .where(eq(memoryChangeItems.summaryId, summaryId))
    .orderBy(asc(memoryChangeItems.filePath));
}

function mockLlm(content = "Today Zero learned one new thing about you."): {
  calls: number;
} {
  const state = { calls: 0 };
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  server.use(
    http.post(OPENROUTER_URL, () => {
      state.calls++;
      return HttpResponse.json({ choices: [{ message: { content } }] });
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

  it("summarizes a closed day with learned and updated items and an LLM narrative", async () => {
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

    expect(response.body).toStrictEqual({ summarized: 1 });
    expect(llm.calls).toBe(1);

    const summary = await findSummary(seeded.fixture);
    expect(summary).not.toBeNull();
    expect(summary?.toVersionId).toBe(seeded.v2Id);
    expect(summary?.summary).toBe(
      "Zero learned your coffee order and updated your pets.",
    );

    const items = await findItems(summary?.id ?? "");
    expect(items).toStrictEqual([
      { kind: "learned", filePath: "facts/coffee.md" },
      { kind: "updated", filePath: "facts/pets.md" },
    ]);
  });

  it("folds MEMORY.md churn into the real file change", async () => {
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
    expect(items).toStrictEqual([
      { kind: "learned", filePath: "facts/coffee.md" },
    ]);
  });

  it("writes no row and makes no LLM call when memory did not change in the day", async () => {
    const llm = mockLlm();
    const seeded = await seedTwoVersions(
      [{ path: "facts/pets.md", content: "Has a dog" }],
      [{ path: "facts/pets.md", content: "Has a dog" }],
    );

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ skipped: true });
    expect(llm.calls).toBe(0);
    await expect(findSummary(seeded.fixture)).resolves.toBeNull();
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

    expect(response.body).toStrictEqual({ summarized: 1 });
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

    expect(response.body).toStrictEqual({ summarized: 1 });
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
    expect(rows).toHaveLength(1);
    await expect(findItems(rows[0]?.id ?? "")).resolves.toHaveLength(1);
  });

  it("backfills every closed day when the cron missed earlier runs", async () => {
    const llm = mockLlm();
    // Three versions across two closed days: 2999-01-01 (v1 -> v2) and
    // 2999-01-02 (v2 -> v3). A single run must summarize both days.
    const { fixture } = await seedVersions([
      {
        createdAt: new Date("2999-01-01T03:00:00.000Z"),
        files: [{ path: "facts/pets.md", content: "Has a dog" }],
      },
      {
        createdAt: new Date("2999-01-01T09:00:00.000Z"),
        files: [{ path: "facts/pets.md", content: "Has a dog and a cat" }],
      },
      {
        createdAt: new Date("2999-01-02T09:00:00.000Z"),
        files: [
          { path: "facts/pets.md", content: "Has a dog and a cat" },
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

    const db = store.set(writeDb$);
    const summaries = await db
      .select({
        date: memoryChangeSummaries.date,
        id: memoryChangeSummaries.id,
      })
      .from(memoryChangeSummaries)
      .where(eq(memoryChangeSummaries.orgId, fixture.orgId))
      .orderBy(asc(memoryChangeSummaries.date));

    expect(
      summaries.map((row) => {
        return row.date;
      }),
    ).toStrictEqual(["2999-01-01", "2999-01-02"]);
    // Day one: pets.md updated (the cat). Day two re-diffs from the day-one
    // baseline, so only coffee.md is new.
    await expect(findItems(summaries[0]?.id ?? "")).resolves.toStrictEqual([
      { kind: "updated", filePath: "facts/pets.md" },
    ]);
    await expect(findItems(summaries[1]?.id ?? "")).resolves.toStrictEqual([
      { kind: "learned", filePath: "facts/coffee.md" },
    ]);
  });
});
