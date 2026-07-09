import { randomUUID } from "node:crypto";

import { cronSummarizeMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { backdateStorageVersion } from "../../../test-fixtures/storage-version-backdate";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  commitMemoryVersion,
  type MemoryFile,
  mockMemoryVersions,
} from "./helpers/zero-memory";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Fixed clock: "today" in UTC is 2999-01-03, so the seven most-recently-closed
// local days are 2998-12-27 through 2999-01-02.
const FIXED_NOW_ISO = "2999-01-03T12:00:00.000Z";
const BASELINE_BEFORE_LOOKBACK = "2998-12-26T03:00:00.000Z";
const BASELINE_DURING_LOOKBACK = "2999-01-01T03:00:00.000Z";
const YESTERDAY = "2999-01-02";
const YESTERDAY_MORNING = "2999-01-02T09:00:00.000Z";

interface MemoryFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface OpenRouterRequestMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenRouterRequestBody {
  readonly model: string;
  readonly messages: readonly OpenRouterRequestMessage[];
  readonly max_tokens?: number;
}

function fixtureActor(fixture: MemoryFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: `${fixture.userId}@example.test`,
  };
}

/**
 * Enable the Memory Viewer feature for a fixture's org/user. The cron only
 * processes users who can see the Memory page; fixtures use random org IDs that
 * do not match the staff-org rollout, so tests opt in through the same
 * per-user feature-switch API available to users.
 */
async function enableMemoryViewer(fixture: MemoryFixture): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.MemoryViewer]: true,
  });
}

async function newFixture(
  overrides: Partial<MemoryFixture> = {},
): Promise<MemoryFixture> {
  const fixture = {
    orgId: overrides.orgId ?? `org_${randomUUID()}`,
    userId: overrides.userId ?? `user_${randomUUID()}`,
  };
  await enableMemoryViewer(fixture);
  // The cron is a global sweep over every MemoryViewer-enabled user in the
  // shared database, so a fixture left enabled would be re-scanned by every
  // later sweep (in this file, in parallel workers, and in future runs) —
  // deliberately broken fixtures would poison those sweeps. Opting back out
  // through the same product feature-switch API keeps sweeps scoped to the
  // running test without a teardown endpoint.
  onTestFinished(async () => {
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.MemoryViewer]: false,
    });
  });
  return fixture;
}

function apiClient() {
  return setupApp({ context })(cronSummarizeMemoryContract);
}

function devRefreshClient() {
  return setupApp({ context })(zeroMemoryDevRefreshContract);
}

function activityClient() {
  return setupApp({ context })(zeroMemoryActivityContract);
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

interface ActivityQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Read the product memory timeline as the fixture's user. */
async function readActivity(fixture: MemoryFixture, query: ActivityQuery = {}) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const response = await accept(
    activityClient().get({ headers: authHeaders(), query }),
    [200],
  );
  return response.body;
}

function entryFilePaths(
  entry:
    | { readonly items: readonly { readonly filePath: string }[] }
    | undefined,
): string[] {
  return (entry?.items ?? []).map((item) => {
    return item.filePath;
  });
}

interface SeededMemory {
  readonly fixture: MemoryFixture;
  readonly v1Id: string;
  readonly v2Id: string;
}

/**
 * Seed a memory artifact through the product storage upload flow whose
 * baseline (v1) predates the seven-day lookback window and whose v2 lands
 * during yesterday. The first cron run backfills six quiet cards and
 * yesterday's v1 -> v2 diff. Version rows get their createdAt from the
 * database clock, so each committed version is back-dated onto its intended
 * day. Identical file sets dedupe onto one content-addressed version, which
 * keeps "no change" days quiet exactly like production.
 */
async function seedTwoVersions(
  files1: readonly MemoryFile[],
  files2: readonly MemoryFile[],
): Promise<SeededMemory> {
  const fixture = await newFixture();
  const actor = fixtureActor(fixture);

  const v1 = await commitMemoryVersion(context, actor, files1);
  await backdateStorageVersion(
    v1.versionId,
    new Date(BASELINE_BEFORE_LOOKBACK),
  );
  const v2 = await commitMemoryVersion(context, actor, files2);
  if (v2.versionId !== v1.versionId) {
    await backdateStorageVersion(v2.versionId, new Date(YESTERDAY_MORNING));
  }

  mockMemoryVersions(context, [
    { s3Key: v1.s3Key, files: files1 },
    { s3Key: v2.s3Key, files: files2 },
  ]);

  return { fixture, v1Id: v1.versionId, v2Id: v2.versionId };
}

/**
 * Seed two versions for a user inside the lookback window without mocking S3
 * content. The caller supplies a single combined S3 mock (so several users can
 * coexist on the shared mock), and may deliberately omit a user's content to
 * make their per-user summarize throw — exercising the cron's per-user error
 * isolation. Placeholder file contents are unique per version so the two
 * commits produce distinct content-addressed versions.
 */
async function seedTwoVersionsNoMock(
  overrides: Partial<MemoryFixture> = {},
): Promise<{
  fixture: MemoryFixture;
  v1Key: string;
  v2Key: string;
  v2Id: string;
}> {
  const fixture = await newFixture(overrides);
  const actor = fixtureActor(fixture);

  const v1 = await commitMemoryVersion(context, actor, [
    { path: "seed.md", content: `v1-${randomUUID()}` },
  ]);
  // v1 appears during the lookback window; v2 lands during yesterday.
  await backdateStorageVersion(
    v1.versionId,
    new Date(BASELINE_DURING_LOOKBACK),
  );
  const v2 = await commitMemoryVersion(context, actor, [
    { path: "seed.md", content: `v2-${randomUUID()}` },
  ]);
  await backdateStorageVersion(v2.versionId, new Date(YESTERDAY_MORNING));

  return { fixture, v1Key: v1.s3Key, v2Key: v2.s3Key, v2Id: v2.versionId };
}

interface DayVersion {
  readonly createdAt: Date;
  readonly files: readonly MemoryFile[];
}

/**
 * Seed a memory artifact with an arbitrary number of versions spread across
 * several days and mock their S3 content. The first version establishes the
 * baseline; each later version is that version's net memory state at its
 * createdAt.
 */
async function seedVersions(versions: readonly DayVersion[]): Promise<{
  fixture: MemoryFixture;
}> {
  const fixture = await newFixture();
  const actor = fixtureActor(fixture);

  const content: { s3Key: string; files: readonly MemoryFile[] }[] = [];
  for (const version of versions) {
    const committed = await commitMemoryVersion(context, actor, version.files);
    await backdateStorageVersion(committed.versionId, version.createdAt);
    content.push({ s3Key: committed.s3Key, files: version.files });
  }

  mockMemoryVersions(context, content);

  return { fixture };
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

  it("returns skipped when there is nothing to summarize", async () => {
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

    // Seven cards: six quiet backfilled days plus yesterday's changed day.
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

    // The product timeline shows only the changed day; quiet backfill days
    // carry no items and are omitted from the read surface.
    const activity = await readActivity(seeded.fixture);
    expect(activity.nextCursor).toBeNull();
    expect(activity.entries).toHaveLength(1);
    const entry = activity.entries[0];
    expect(entry?.date).toBe(YESTERDAY);
    expect(entry?.fromVersionId).toBe(seeded.v1Id);
    expect(entry?.toVersionId).toBe(seeded.v2Id);
    expect(entry?.summary).toBe(
      "Zero learned your coffee order and updated your pets.",
    );
    expect(entryFilePaths(entry)).toStrictEqual([
      "facts/coffee.md",
      "facts/pets.md",
    ]);
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

    const activity = await readActivity(seeded.fixture);
    expect(activity.entries).toHaveLength(1);
    expect(entryFilePaths(activity.entries[0])).toStrictEqual([
      "facts/zero-search.md",
    ]);
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

    const activity = await readActivity(seeded.fixture);
    expect(activity.entries).toHaveLength(1);
    const items = entryFilePaths(activity.entries[0]);
    expect(items).toHaveLength(2);
    expect(items).toContain("MEMORY.md");
    expect(items).toContain("facts/coffee.md");
  });

  it("treats zero-file memory versions as empty without S3 objects", async () => {
    const llm = mockLlm("Zero learned your preferred package manager.");
    const fixture = await newFixture();
    const actor = fixtureActor(fixture);

    const emptyVersion = await commitMemoryVersion(context, actor, []);
    await backdateStorageVersion(
      emptyVersion.versionId,
      new Date(BASELINE_BEFORE_LOOKBACK),
    );
    const nonEmptyFiles = [
      { path: "facts/package-manager.md", content: "Uses pnpm" },
    ];
    const nonEmptyVersion = await commitMemoryVersion(
      context,
      actor,
      nonEmptyFiles,
    );
    await backdateStorageVersion(
      nonEmptyVersion.versionId,
      new Date(YESTERDAY_MORNING),
    );
    mockMemoryVersions(context, [
      { s3Key: nonEmptyVersion.s3Key, files: nonEmptyFiles },
    ]);

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ summarized: 7 });
    expect(llm.calls).toBe(1);
    const activity = await readActivity(fixture);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]?.fromVersionId).toBe(emptyVersion.versionId);
    expect(activity.entries[0]?.toVersionId).toBe(nonEmptyVersion.versionId);
    expect(entryFilePaths(activity.entries[0])).toStrictEqual([
      "facts/package-manager.md",
    ]);
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

    // All seven closed days get quiet cards, none burns an LLM call, and the
    // product timeline stays empty because quiet cards carry no items.
    expect(response.body).toStrictEqual({ summarized: 7 });
    expect(llm.calls).toBe(0);
    const activity = await readActivity(seeded.fixture);
    expect(activity.entries).toStrictEqual([]);
    expect(activity.nextCursor).toBeNull();
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
    const activity = await readActivity(seeded.fixture);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]?.summary).toBeNull();
    expect(activity.entries[0]?.items).toHaveLength(2);
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
    const activity = await readActivity(seeded.fixture);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]?.summary).toBeNull();
    expect(activity.entries[0]?.items).toHaveLength(2);
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
    const activity = await readActivity(seeded.fixture);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]?.summary).toBeNull();
    expect(activity.entries[0]?.items).toHaveLength(1);
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
    const first = await readActivity(seeded.fixture);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]?.items).toHaveLength(1);

    // Rerunning the sweep must not duplicate or rewrite this user's summary.
    // The global cron response is deliberately not asserted: concurrently
    // running test files can hand the sweep new work, so only fixture-scoped
    // state is stable here.
    await accept(apiClient().summarize({ headers: cronHeaders() }), [200]);

    const second = await readActivity(seeded.fixture);
    expect(second.entries).toStrictEqual(first.entries);
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

    const healthyActivity = await readActivity(healthy.fixture);
    expect(healthyActivity.entries).toHaveLength(2);
    expect(healthyActivity.entries[0]?.date).toBe(YESTERDAY);
    expect(healthyActivity.entries[0]?.toVersionId).toBe(healthy.v2Id);
    expect(entryFilePaths(healthyActivity.entries[0])).toStrictEqual([
      "facts/coffee.md",
    ]);

    const brokenActivity = await readActivity(broken.fixture);
    expect(brokenActivity.entries).toStrictEqual([]);
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

    // Four cards: three changed days plus the quiet 2998-12-31 (quiet cards
    // are counted by the cron but omitted from the item-bearing timeline).
    expect(response.body).toStrictEqual({ summarized: 4 });
    expect(llm.calls).toBe(3);

    const activity = await readActivity(fixture);
    expect(
      activity.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual([YESTERDAY, "2999-01-01", "2998-12-30"]);
    // Each card is that day's delta only: `e.md` yesterday, NOT a,b,c,d.
    expect(entryFilePaths(activity.entries[0])).toStrictEqual(["facts/e.md"]);
    expect(entryFilePaths(activity.entries[1])).toStrictEqual(["facts/d.md"]);
    expect(entryFilePaths(activity.entries[2])).toStrictEqual([
      "facts/a.md",
      "facts/b.md",
      "facts/c.md",
    ]);

    // The timeline paginates with a date cursor over item-bearing days.
    const firstPage = await readActivity(fixture, { limit: 1 });
    expect(
      firstPage.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual([YESTERDAY]);
    expect(firstPage.nextCursor).toBe(YESTERDAY);

    const secondPage = await readActivity(fixture, {
      limit: 1,
      cursor: firstPage.nextCursor ?? "",
    });
    expect(
      secondPage.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual(["2999-01-01"]);
    expect(secondPage.nextCursor).toBe("2999-01-01");

    const thirdPage = await readActivity(fixture, {
      limit: 1,
      cursor: secondPage.nextCursor ?? "",
    });
    expect(
      thirdPage.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual(["2998-12-30"]);
    expect(thirdPage.nextCursor).toBeNull();
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

    const activity = await readActivity(fixture);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]?.date).toBe(YESTERDAY);
    expect(activity.entries[0]?.fromVersionId).toBeNull();
    expect(entryFilePaths(activity.entries[0])).toStrictEqual([
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
    await deleteFeatureSwitchesForUser(context, disabled.fixture);

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

    const enabledActivity = await readActivity(enabled.fixture);
    expect(enabledActivity.entries).toHaveLength(2);
    expect(enabledActivity.entries[0]?.toVersionId).toBe(enabled.v2Id);
    const disabledActivity = await readActivity(disabled.fixture);
    expect(disabledActivity.entries).toStrictEqual([]);
  });

  it("scopes memory activity reads to the authenticated user and org", async () => {
    const llm = mockLlm();
    const mine = await seedTwoVersionsNoMock();
    // Same org, different user: must not leak into my timeline.
    const sameOrgPeer = await seedTwoVersionsNoMock({
      orgId: mine.fixture.orgId,
    });
    // Same user id in a different org: must not leak across orgs.
    const otherOrgSelf = await seedTwoVersionsNoMock({
      userId: mine.fixture.userId,
    });

    mockMemoryVersions(context, [
      {
        s3Key: mine.v1Key,
        files: [{ path: "mine/base.md", content: "mine base" }],
      },
      {
        s3Key: mine.v2Key,
        files: [
          { path: "mine/base.md", content: "mine base" },
          { path: "mine/new.md", content: "mine new" },
        ],
      },
      {
        s3Key: sameOrgPeer.v1Key,
        files: [{ path: "peer/base.md", content: "peer base" }],
      },
      {
        s3Key: sameOrgPeer.v2Key,
        files: [
          { path: "peer/base.md", content: "peer base" },
          { path: "peer/new.md", content: "peer new" },
        ],
      },
      {
        s3Key: otherOrgSelf.v1Key,
        files: [{ path: "other/base.md", content: "other base" }],
      },
      {
        s3Key: otherOrgSelf.v2Key,
        files: [
          { path: "other/base.md", content: "other base" },
          { path: "other/new.md", content: "other new" },
        ],
      },
    ]);

    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual({ summarized: 6 });
    expect(llm.calls).toBe(6);

    const mineActivity = await readActivity(mine.fixture);
    expect(
      mineActivity.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual([YESTERDAY, "2999-01-01"]);
    expect(mineActivity.entries[0]?.toVersionId).toBe(mine.v2Id);
    expect(entryFilePaths(mineActivity.entries[0])).toStrictEqual([
      "mine/new.md",
    ]);
    expect(entryFilePaths(mineActivity.entries[1])).toStrictEqual([
      "mine/base.md",
    ]);

    const peerActivity = await readActivity(sameOrgPeer.fixture);
    expect(entryFilePaths(peerActivity.entries[0])).toStrictEqual([
      "peer/new.md",
    ]);
    const otherOrgActivity = await readActivity(otherOrgSelf.fixture);
    expect(entryFilePaths(otherOrgActivity.entries[0])).toStrictEqual([
      "other/new.md",
    ]);
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
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [403],
    ).finally(() => {
      mockEnv("ENV", "development");
    });

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

    const oldLlm = mockLlm("Old prompt summary");
    mocks.clerk.session(current.fixture.userId, current.fixture.orgId);
    const first = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [200],
    );
    expect(first.body).toStrictEqual({ summarized: 2 });
    expect(oldLlm.calls).toBe(2);

    const before = await readActivity(current.fixture);
    expect(before.entries).toHaveLength(2);
    expect(before.entries[0]?.summary).toBe("Old prompt summary");
    const otherBefore = await readActivity(other.fixture);
    expect(otherBefore.entries).toStrictEqual([]);

    const newLlm = mockLlm("New prompt summary");
    mocks.clerk.session(current.fixture.userId, current.fixture.orgId);
    const second = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [200],
    );

    expect(second.body).toStrictEqual({ summarized: 2 });
    expect(newLlm.calls).toBe(2);
    const after = await readActivity(current.fixture);
    expect(after.entries).toHaveLength(2);
    expect(after.entries[0]?.date).toBe(before.entries[0]?.date);
    expect(after.entries[0]?.summary).toBe("New prompt summary");
    const otherAfter = await readActivity(other.fixture);
    expect(otherAfter.entries).toStrictEqual([]);
  });
});
