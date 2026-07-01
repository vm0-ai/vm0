import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import { createStore } from "ccstate";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_EVENT_SEQUENCE_NUMBER } from "@vm0/api-contracts/contracts/runs";
import { zeroAgentInstructionsContract } from "@vm0/api-contracts/contracts/zero-agents";

import { env } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { accept, setupApp } from "../../../__tests__/test-helpers";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  cleanupUserExportState,
  createOpsLogsApi,
  seedUserExportChatMessages,
} from "./helpers/api-bdd-ops-logs";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { seedMemoryStorage$ } from "./helpers/zero-memory";
import { createFixtureTracker } from "./helpers/zero-route-test";

/*
 * OPS-01 run log search, BILL-02 model stats, and OPS-01 user export.
 *
 * This file is the SOLE OWNER of GET /api/cron/aggregate-model-stats:
 * the cron is a global sweep (window-scoped DELETE+reinsert over model_stat
 * plus an unconditional model_usage_observation retention delete), so calling
 * it from any other test file would race this file's far-past observation
 * windows on the shared database — the same single-file-ownership rule as the
 * email drain / billing reconcile / screenshot cleanup crons (see the shared
 * cron auth helper in helpers/api-bdd-runs-automations.ts).
 *
 * Shared-DB time design: the model-stats chain derives a random far-past UTC
 * day (2003-2009) per run and asserts rankings as baseline+delta, so leftovers
 * from interrupted past runs in a colliding window cannot flake assertions.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
// Register before testContext(): Vitest runs afterEach hooks in stack order, so
// this cleanup runs after testContext drains detached user-export work.
const trackUserExportActor = createFixtureTracker<ApiTestUser>(
  cleanupUserExportState,
);

interface DeferredS3Put {
  readonly resolve: () => void;
}

async function createUserExportActor(
  bdd: ReturnType<typeof createBddApi>,
): Promise<ApiTestUser> {
  return await trackUserExportActor(Promise.resolve(bdd.user()));
}

const context = testContext();
const store = createStore();
const trackDeferredS3Put = createFixtureTracker<DeferredS3Put>((pendingPut) => {
  pendingPut.resolve();
  return Promise.resolve();
});

type UserExportStatusBody = Extract<
  Awaited<
    ReturnType<ReturnType<typeof createOpsLogsApi>["requestGetUserExport"]>
  >["body"],
  { job: unknown }
>;

afterEach(() => {
  clearMockNow();
});

async function entitledRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsAutomationsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD ops-logs agent",
    description: "Exercises log search and model usage observation flows.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

function axiomEvent(
  runId: string,
  sequenceNumber: number,
  text: string,
  timestamp = "2026-01-15T10:30:00Z",
): Record<string, unknown> {
  return {
    _time: timestamp,
    runId,
    userId: "bdd-log-search",
    sequenceNumber,
    eventType: "assistant",
    eventData: {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
  };
}

function lastAxiomApl(): string {
  const apl = context.mocks.axiom.query.mock.calls.at(-1)?.[0];
  if (typeof apl !== "string") {
    throw new Error("Expected the last Axiom query call to receive an APL");
  }
  return apl;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function exportZip(exportKey: string): AdmZip {
  const putInput = context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return commandInput(command);
    })
    .find((input) => {
      return input.Key === exportKey;
    });

  const body = putInput?.Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error(`Expected export ZIP upload for ${exportKey}`);
  }
  return new AdmZip(body);
}

function zipEntryNames(zip: AdmZip): string[] {
  return zip.getEntries().map((entry) => {
    return entry.entryName;
  });
}

function zipText(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`Expected ZIP entry ${name}`);
  }
  return entry.getData().toString("utf8");
}

function singleZipEntry(
  names: readonly string[],
  predicate: (name: string) => boolean,
): string {
  const matches = names.filter(predicate);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error("Expected one ZIP entry match");
  }
  return match;
}

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function createTarEntry(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(octal(content.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write("0", 156);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = content.length % TAR_BLOCK_SIZE;
  const data =
    padding === 0
      ? content
      : Buffer.concat([content, Buffer.alloc(TAR_BLOCK_SIZE - padding)]);
  return Buffer.concat([header, data]);
}

function createTarGz(
  files: readonly { readonly path: string; readonly content: string }[],
): Buffer {
  return gzipSync(
    Buffer.concat([
      ...files.map((file) => {
        return createTarEntry(file.path, Buffer.from(file.content, "utf8"));
      }),
      Buffer.alloc(TAR_BLOCK_SIZE * 2),
    ]),
  );
}

function putMemoryArchive(
  misc: ReturnType<typeof createMiscRoutesApi>,
  s3Key: string,
  files: readonly { readonly path: string; readonly content: string }[],
): void {
  const manifestFiles = files.map((file) => {
    return {
      path: file.path,
      hash: `bdd-${file.path}`,
      size: Buffer.byteLength(file.content, "utf8"),
    };
  });
  misc.putS3Object(
    `${s3Key}/manifest.json`,
    JSON.stringify({
      version: "bdd-memory",
      createdAt: new Date(0).toISOString(),
      files: manifestFiles,
      totalSize: manifestFiles.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      fileCount: manifestFiles.length,
    }),
  );
  misc.putS3Object(`${s3Key}/archive.tar.gz`, createTarGz(files));
}

function unsubscribeToken(userId: string): string {
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${signature}`;
}

async function waitForUserExportJobStatus(
  api: ReturnType<typeof createOpsLogsApi>,
  actor: ApiTestUser,
  jobId: string,
  status: "completed" | "failed" | "pending" | "running",
) {
  let body: UserExportStatusBody | undefined;
  await expect
    .poll(async () => {
      const response = await api.requestGetUserExport(actor, [200]);
      if (!("job" in response.body)) {
        return null;
      }
      body = response.body;
      return body.job?.id === jobId ? body.job.status : null;
    })
    .toBe(status);
  if (!body) {
    throw new Error(`Expected user export job ${jobId} to become ${status}`);
  }
  return body;
}

describe("BILL-02: model usage aggregation and public rankings", () => {
  it("rejects the model-stats aggregation cron without the cron secret", async () => {
    const api = createOpsLogsApi(context);

    const rejected = await api.requestAggregateModelStats(
      "invalid",
      undefined,
      [401],
    );
    expect(rejected.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("aggregates sandbox model observations into public rankings and applies retention", async () => {
    const api = createOpsLogsApi(context);
    const runs = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const model = "claude-sonnet-4-6";

    // Random far-past UTC day (2003-2009): immune to the soon-deleted legacy
    // model-stats cron (its retention windows live in 2001) and far enough in
    // the past that the retention sweep below cannot touch real-now rows.
    const seed = Number.parseInt(randomUUID().slice(0, 8), 16);
    const dayYear = 2003 + (seed % 7);
    const dayMonth = Math.floor(seed / 7) % 12;
    const dayStart = Date.UTC(
      dayYear,
      dayMonth,
      2 + (Math.floor(seed / 84) % 26),
    );
    const aggregateAt = dayStart + 4 * HOUR_MS;
    const mainObservedAt = dayStart + 2 * HOUR_MS + 10 * 60_000;
    const previousObservedAt = dayStart - DAY_MS + 22 * HOUR_MS + 30 * 60_000;
    const windowStartIso = new Date(aggregateAt - DAY_MS).toISOString();
    const windowEndIso = new Date(aggregateAt).toISOString();
    const todayStartIso = new Date(dayStart).toISOString();

    // Given: the run and its sandbox token are created at the real wall
    // clock, then terminal-ized before any mocked-time ingestion.
    const { actor, agentId } = await entitledRunActor();
    const created = await runs.createRun(actor, {
      agentId,
      prompt: "observe model usage",
      modelProvider: "anthropic-api-key",
    });
    const sandboxHeaders = {
      authorization: `Bearer ${runs.sandboxTokenForRun(actor, created.runId)}`,
    };
    await runs.requestCancelRun(actor, created.runId, [200]);

    mockNow(aggregateAt);
    const baselineAggregate = await api.requestAggregateModelStats(
      "valid",
      undefined,
      [200],
    );
    expect(baselineAggregate.body).toMatchObject({
      success: true,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
    });

    const baseline = await api.readModelRankings("today");
    expect(baseline.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    expect(baseline.body.period).toBe("today");
    expect(baseline.body.windowStart).toBe(todayStartIso);
    expect(baseline.body.windowEnd).toBe(windowEndIso);
    const baseRow = baseline.body.rows.find((row) => {
      return row.model === model;
    }) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      previousTotalTokens: 0,
    };
    const baseTotal = baseline.body.totalTokens;

    mockNow(mainObservedAt);
    const ingested = await webhooks.requestAgentModelUsageObservation(
      {
        runId: created.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model,
            category: "tokens.input",
            quantity: 300,
          },
          {
            idempotencyKey: randomUUID(),
            model,
            category: "tokens.output",
            quantity: 200,
          },
          {
            idempotencyKey: randomUUID(),
            model,
            category: "tokens.cache_read",
            quantity: 40,
          },
          {
            idempotencyKey: randomUUID(),
            model,
            category: "tokens.cache_creation",
            quantity: 10,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(ingested.body).toStrictEqual({ success: true });

    mockNow(previousObservedAt);
    await webhooks.requestAgentModelUsageObservation(
      {
        runId: created.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model,
            category: "tokens.input",
            quantity: 80,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    mockNow(aggregateAt);
    const aggregated = await api.requestAggregateModelStats("valid", 24, [200]);
    expect(aggregated.body.success).toBeTruthy();
    expect(aggregated.body.windowStart).toBe(windowStartIso);
    expect(aggregated.body.windowEnd).toBe(windowEndIso);
    expect(aggregated.body.aggregated).toBeGreaterThanOrEqual(2);

    const afterIngest = await api.readModelRankings("today");
    expect(
      afterIngest.body.rows.find((row) => {
        return row.model === model;
      }),
    ).toStrictEqual({
      model,
      inputTokens: baseRow.inputTokens + 350,
      outputTokens: baseRow.outputTokens + 200,
      totalTokens: baseRow.totalTokens + 550,
      previousTotalTokens: baseRow.previousTotalTokens + 80,
    });
    expect(afterIngest.body.totalTokens).toBe(baseTotal + 550);

    // Re-ingest into the already-aggregated hour: the window DELETE+reinsert
    // must surface the additional output tokens on the next aggregation.
    mockNow(mainObservedAt);
    await webhooks.requestAgentModelUsageObservation(
      {
        runId: created.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model,
            category: "tokens.output",
            quantity: 50,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    mockNow(aggregateAt);
    await api.requestAggregateModelStats("valid", 24, [200]);
    const reprocessed = await api.readModelRankings("today");
    expect(
      reprocessed.body.rows.find((row) => {
        return row.model === model;
      }),
    ).toStrictEqual({
      model,
      inputTokens: baseRow.inputTokens + 350,
      outputTokens: baseRow.outputTokens + 250,
      totalTokens: baseRow.totalTokens + 600,
      previousTotalTokens: baseRow.previousTotalTokens + 80,
    });
    expect(reprocessed.body.totalTokens).toBe(baseTotal + 600);

    // Month-period rankings: window asserts only — the month window can
    // contain leftovers accumulated by colliding past runs.
    const monthly = await api.readModelRankings("month");
    expect(monthly.body.period).toBe("month");
    expect(monthly.body.windowStart).toBe(
      new Date(Date.UTC(dayYear, dayMonth, 1)).toISOString(),
    );
    expect(monthly.body.windowEnd).toBe(windowEndIso);
    const monthlyRow = monthly.body.rows.find((row) => {
      return row.model === model;
    });
    expect(monthlyRow?.totalTokens).toBeGreaterThanOrEqual(600);

    const fallback = await api.readModelRankings("unsupported");
    expect(fallback.body.period).toBe("week");

    // Retention: 33 days later the cron deletes every observation at or
    // before our day; the re-aggregation then empties the window's stats, so
    // the strict empty read is safe even against colliding leftovers.
    mockNow(dayStart + 33 * DAY_MS + 4 * HOUR_MS);
    const retention = await api.requestAggregateModelStats(
      "valid",
      undefined,
      [200],
    );
    expect(retention.body.success).toBeTruthy();

    mockNow(aggregateAt);
    await api.requestAggregateModelStats("valid", 24, [200]);
    const emptied = await api.readModelRankings("today");
    expect(emptied.body).toStrictEqual({
      period: "today",
      totalTokens: 0,
      windowStart: todayStartIso,
      windowEnd: windowEndIso,
      rows: [],
    });
  });
});

describe("OPS-01: run log search via /api/logs/search", () => {
  it("searches run logs with keyword, context, filters, and pagination through the api", async () => {
    const api = createOpsLogsApi(context);
    const runs = createRunsAutomationsApi(context);
    const { actor, agentId } = await entitledRunActor();
    const created = await runs.createRun(actor, {
      agentId,
      prompt: "emit searchable logs",
      modelProvider: "anthropic-api-key",
    });
    const runId = created.runId;

    context.mocks.axiom.query.mockResolvedValueOnce([]);
    const empty = await api.requestSearchLogs(
      actor,
      { keyword: "nonexistent" },
      [200],
    );
    expect(empty.body).toStrictEqual({ results: [], hasMore: false });

    const invalidSince = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", since: 8_640_000_000_000_001 },
      [400],
    );
    expectApiError(invalidSince.body);

    const invalidLimit = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", limit: 1.5 },
      [400],
    );
    expectApiError(invalidLimit.body);

    const invalidBefore = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", before: 1.5 },
      [400],
    );
    expectApiError(invalidBefore.body);

    const invalidAfter = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", after: 1.5 },
      [400],
    );
    expectApiError(invalidAfter.body);

    const blankContext = await api.rawSearchLogs(
      actor,
      "?keyword=OOM&before=&after=",
    );
    expect(blankContext.status).toBe(400);
    expectApiError(blankContext.body);

    const blankKeyword = await api.rawSearchLogs(actor, "?keyword=%20%20");
    expect(blankKeyword.status).toBe(400);
    expectApiError(blankKeyword.body);

    const invalidRunId = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", runId: "not-a-uuid" },
      [400],
    );
    expectApiError(invalidRunId.body);

    const axiomCallsBeforeMalformed =
      context.mocks.axiom.query.mock.calls.length;
    context.mocks.axiom.query.mockResolvedValueOnce([
      { ...axiomEvent(runId, 3, "Error: OOM killed"), sequenceNumber: "bad" },
      {
        ...axiomEvent(runId, 4, "Error: OOM killed"),
        sequenceNumber: MAX_EVENT_SEQUENCE_NUMBER + 1,
      },
      { ...axiomEvent(runId, 5, "Error: OOM killed"), _time: "not-a-date" },
    ]);
    const malformedAxiomRow = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", before: 1, after: 1 },
      [200],
    );
    expect(malformedAxiomRow.body).toStrictEqual({
      results: [],
      hasMore: false,
    });
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      axiomCallsBeforeMalformed + 1,
    );

    context.mocks.axiom.query.mockResolvedValueOnce([
      axiomEvent(runId, 3, "Error: OOM killed"),
    ]);
    const matched = await api.requestSearchLogs(
      actor,
      { keyword: "OOM" },
      [200],
    );
    expect(matched.body.results).toHaveLength(1);
    expect(matched.body.results[0]?.runId).toBe(runId);
    expect(matched.body.results[0]?.agentName).toBe("BDD ops-logs agent");
    expect(matched.body.results[0]?.framework).toBe("claude-code");
    expect(matched.body.results[0]?.matchedEvent.sequenceNumber).toBe(3);
    expect(matched.body.results[0]?.contextBefore).toStrictEqual([]);
    expect(matched.body.results[0]?.contextAfter).toStrictEqual([]);
    const broadApl = lastAxiomApl();
    expect(broadApl).toContain('search "*OOM*"');
    expect(broadApl).toContain(`runId == "${runId}"`);

    context.mocks.axiom.query.mockResolvedValueOnce([]);
    const escapedKeywordSearch = await api.requestSearchLogs(
      actor,
      { keyword: 'quote" slash\\ tab\t newline\n carriage\r return' },
      [200],
    );
    expect(escapedKeywordSearch.body).toStrictEqual({
      results: [],
      hasMore: false,
    });
    const escapedSearchLine = lastAxiomApl()
      .split("\n")
      .find((line) => {
        return line.includes("| search");
      });
    expect(escapedSearchLine).toBe(
      String.raw`| search "*quote\" slash\\ tab\t newline\n carriage\n return*"`,
    );

    context.mocks.axiom.query
      .mockResolvedValueOnce([
        axiomEvent(runId, 5, "Error: OOM killed", "2026-01-15T10:30:05Z"),
      ])
      .mockResolvedValueOnce([
        axiomEvent(runId, 4, "Building...", "2026-01-15T10:30:04Z"),
        axiomEvent(runId, 5, "Error: OOM killed", "2026-01-15T10:30:05Z"),
        axiomEvent(runId, 6, "Retrying...", "2026-01-15T10:30:06Z"),
      ]);
    const withContext = await api.requestSearchLogs(
      actor,
      { keyword: "OOM", before: 1, after: 1 },
      [200],
    );
    expect(withContext.body.results).toHaveLength(1);
    expect(withContext.body.results[0]?.matchedEvent.sequenceNumber).toBe(5);
    expect(withContext.body.results[0]?.contextBefore).toHaveLength(1);
    expect(withContext.body.results[0]?.contextBefore[0]?.sequenceNumber).toBe(
      4,
    );
    expect(withContext.body.results[0]?.contextAfter).toHaveLength(1);
    expect(withContext.body.results[0]?.contextAfter[0]?.sequenceNumber).toBe(
      6,
    );

    context.mocks.axiom.query.mockResolvedValueOnce([
      axiomEvent(runId, 1, "Found it"),
    ]);
    const byRunId = await api.requestSearchLogs(
      actor,
      { keyword: "Found", runId },
      [200],
    );
    expect(byRunId.body.results).toHaveLength(1);
    expect(byRunId.body.results[0]?.runId).toBe(runId);
    expect(lastAxiomApl()).toContain(`runId == "${runId}"`);

    const axiomCallsBeforeMismatchedRunAgent =
      context.mocks.axiom.query.mock.calls.length;
    const mismatchedRunAgent = await api.requestSearchLogs(
      actor,
      { keyword: "Found", runId, agentId: randomUUID() },
      [200],
    );
    expect(mismatchedRunAgent.body).toStrictEqual({
      results: [],
      hasMore: false,
    });
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      axiomCallsBeforeMismatchedRunAgent,
    );

    context.mocks.axiom.query.mockResolvedValueOnce([
      axiomEvent(runId, 2, "Found again"),
    ]);
    const byRunAndAgent = await api.requestSearchLogs(
      actor,
      { keyword: "Found", runId, agentId },
      [200],
    );
    expect(byRunAndAgent.body.results).toHaveLength(1);
    expect(byRunAndAgent.body.results[0]?.runId).toBe(runId);

    context.mocks.axiom.query.mockResolvedValueOnce([
      axiomEvent(runId, 1, "Agent scoped event"),
    ]);
    const byAgentId = await api.requestSearchLogs(
      actor,
      { keyword: "event", agentId },
      [200],
    );
    expect(byAgentId.body.results).toHaveLength(1);
    expect(byAgentId.body.results[0]?.runId).toBe(runId);

    const axiomCallsBeforeMissingAgent =
      context.mocks.axiom.query.mock.calls.length;
    const missingAgent = await api.requestSearchLogs(
      actor,
      { keyword: "event", agentId: randomUUID() },
      [200],
    );
    expect(missingAgent.body).toStrictEqual({ results: [], hasMore: false });
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      axiomCallsBeforeMissingAgent,
    );

    context.mocks.axiom.query.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, index) => {
        return axiomEvent(runId, index, `Match ${index}`);
      }),
    );
    const paged = await api.requestSearchLogs(
      actor,
      { keyword: "Match", limit: 2 },
      [200],
    );
    expect(paged.body.results).toHaveLength(2);
    expect(paged.body.hasMore).toBeTruthy();

    const missingKeyword = await api.rawSearchLogs(actor, "?limit=10");
    expect(missingKeyword.status).toBe(400);

    await runs.requestCancelRun(actor, runId, [200]);
  });

  it("scopes log search to the caller's organization runs", async () => {
    const api = createOpsLogsApi(context);
    const runs = createRunsAutomationsApi(context);
    const first = await entitledRunActor();
    const firstRun = await runs.createRun(first.actor, {
      agentId: first.agentId,
      prompt: "first org run",
      modelProvider: "anthropic-api-key",
    });
    const second = await entitledRunActor();
    const secondRun = await runs.createRun(second.actor, {
      agentId: second.agentId,
      prompt: "second org run",
      modelProvider: "anthropic-api-key",
    });

    context.mocks.axiom.query.mockResolvedValueOnce([
      axiomEvent(firstRun.runId, 1, "Own org event"),
    ]);
    const broad = await api.requestSearchLogs(
      first.actor,
      { keyword: "event" },
      [200],
    );
    expect(broad.body.results).toHaveLength(1);
    expect(broad.body.results[0]?.runId).toBe(firstRun.runId);
    const broadApl = lastAxiomApl();
    expect(broadApl).toContain(firstRun.runId);
    expect(broadApl).not.toContain(secondRun.runId);

    const axiomCallsBeforeForeignRun =
      context.mocks.axiom.query.mock.calls.length;
    const foreignRun = await api.requestSearchLogs(
      first.actor,
      { keyword: "event", runId: secondRun.runId },
      [200],
    );
    expect(foreignRun.body).toStrictEqual({ results: [], hasMore: false });
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      axiomCallsBeforeForeignRun,
    );

    await runs.requestCancelRun(first.actor, firstRun.runId, [200]);
    await runs.requestCancelRun(second.actor, secondRun.runId, [200]);
  });

  it("rejects unauthenticated and org-less log searches", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const expectedError = {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    };

    const unauthenticated = await api.requestSearchLogs(
      null,
      { keyword: "test" },
      [401],
    );
    expect(unauthenticated.body).toStrictEqual(expectedError);

    const orgless = await api.requestSearchLogs(
      bdd.user({ orgId: null }),
      { keyword: "test" },
      [401],
    );
    expect(orgless.body).toStrictEqual(expectedError);
  });
});

describe("OPS-01: user data export", () => {
  it("rejects unauthenticated and org-less export requests", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const expectedError = {
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    };

    const getUnauthenticated = await api.requestGetUserExport(null, [401]);
    expect(getUnauthenticated.body).toStrictEqual(expectedError);

    const postUnauthenticated = await api.requestPostUserExport(null, [401]);
    expect(postUnauthenticated.body).toStrictEqual(expectedError);

    const orgless = await api.requestPostUserExport(
      bdd.user({ orgId: null }),
      [401],
    );
    expect(orgless.body).toStrictEqual(expectedError);
  });

  it("exports user data end to end with active, cooldown, refresh, and latest-job visibility", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = await createUserExportActor(bdd);
    const exportStartAt = Date.UTC(2026, 4, 12, 5);
    const downloadUrl = "https://r2.example.com/bdd-export.zip?sig=test";

    mockNow(exportStartAt);
    const before = await api.requestGetUserExport(actor, [200]);
    expect(before.body).toStrictEqual({
      job: null,
      canExport: true,
      nextExportAt: null,
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    const pendingPut = await trackDeferredS3Put(
      Promise.resolve(api.deferS3PutOnce()),
    );

    const started = await api.requestPostUserExport(actor, [202]);
    expect(started.body.status).toBe("pending");
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    const reposted = await api.requestPostUserExport(actor, [202]);
    expect(reposted.body.jobId).toBe(jobId);
    expect(["pending", "running"]).toContain(reposted.body.status);

    const active = await api.requestGetUserExport(actor, [200]);
    expect(active.body.job?.id).toBe(jobId);
    expect(["pending", "running"]).toContain(active.body.job?.status);
    expect(active.body.job?.downloadUrl).toBeNull();
    expect(active.body.canExport).toBeFalsy();
    expect(active.body.nextExportAt).toBeNull();

    pendingPut.resolve();

    const completed = await waitForUserExportJobStatus(
      api,
      actor,
      jobId,
      "completed",
    );
    expect(completed).toStrictEqual({
      job: {
        id: jobId,
        status: "completed",
        createdAt: new Date(exportStartAt).toISOString(),
        completedAt: new Date(exportStartAt).toISOString(),
        expiresAt: new Date(exportStartAt + 72 * HOUR_MS).toISOString(),
        downloadUrl,
        error: null,
      },
      canExport: false,
      nextExportAt: new Date(exportStartAt + 24 * HOUR_MS).toISOString(),
    });

    const signedUrlCommand = commandInput(
      context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1],
    );
    expect(signedUrlCommand).toMatchObject({
      Bucket: "test-user-storages",
      Key: exportKey,
      ResponseContentDisposition: 'attachment; filename="vm0-data-export.zip"',
    });

    const putInput = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command);
      })
      .find((input) => {
        return input.Key === exportKey;
      });
    expect(putInput).toMatchObject({
      Bucket: "test-user-storages",
      ContentType: "application/zip",
    });
    expect(putInput?.Body).toBeInstanceOf(Buffer);

    const limited = await api.requestPostUserExport(actor, [429]);
    expect(limited.body).toStrictEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Export already completed within the last 24 hours",
      },
    });

    const expiredReadAt = exportStartAt + 73 * HOUR_MS;
    mockNow(expiredReadAt);
    const signedUrlCalls = context.mocks.s3.getSignedUrl.mock.calls.length;
    const expired = await api.requestGetUserExport(actor, [200]);
    expect(expired.body.job?.id).toBe(jobId);
    expect(expired.body.job?.downloadUrl).toBeNull();
    expect(expired.body.canExport).toBeTruthy();
    expect(expired.body.nextExportAt).toBeNull();
    expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
      signedUrlCalls,
    );

    // auth-me refreshes the user email cache at the mocked time, so the
    // second export execution reads the fresh-cache arm instead of Clerk.
    await bdd.readMe(actor);
    context.mocks.s3.send.mockResolvedValue({});
    const restarted = await api.requestPostUserExport(actor, [202]);
    expect(restarted.body.jobId).not.toBe(jobId);

    const latest = await waitForUserExportJobStatus(
      api,
      actor,
      restarted.body.jobId,
      "completed",
    );
    expect(latest.job).toStrictEqual({
      id: restarted.body.jobId,
      status: "completed",
      createdAt: new Date(expiredReadAt).toISOString(),
      completedAt: new Date(expiredReadAt).toISOString(),
      expiresAt: new Date(expiredReadAt + 72 * HOUR_MS).toISOString(),
      downloadUrl,
      error: null,
    });

    const peer = bdd.user();
    const peerStatus = await api.requestGetUserExport(peer, [200]);
    expect(peerStatus.body).toStrictEqual({
      job: null,
      canExport: true,
      nextExportAt: null,
    });
  });

  it("exports only agent instruction files, workflow files, memory files, and text chat messages", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = await createUserExportActor(bdd);
    const exportStartAt = Date.UTC(2026, 4, 12, 5);
    const downloadUrl =
      "https://r2.example.com/bdd-export-content.zip?sig=test";
    if (!actor.orgId) {
      throw new Error("Expected export test actor to have an org");
    }

    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Agent",
      visibility: "private",
    });
    await accept(
      setupApp({ context })(zeroAgentInstructionsContract).update({
        params: { id: agent.agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "Use the exported agent instructions." },
      }),
      [200],
    );

    const workflow = await misc.createWorkflow(
      actor,
      agent.agentId,
      "bdd-export-workflow",
      {
        content: "Use the exported workflow instructions.",
        files: [
          {
            path: "notes/checklist.md",
            content: "Workflow supporting file",
          },
        ],
      },
      [201],
    );
    expect("id" in workflow.body).toBeTruthy();
    if (!("id" in workflow.body)) {
      throw new Error("Expected workflow creation to return a workflow id");
    }
    const workflowId = workflow.body.id;
    const threadId = randomUUID();
    await seedUserExportChatMessages({
      userId: actor.userId,
      agentId: agent.agentId,
      threadId,
    });
    const memoryVersionId = `bdd-memory-${randomUUID()}`;
    const memoryS3Key = `${actor.orgId}/artifact/memory/${memoryVersionId}`;
    const memoryFiles = [
      { path: "MEMORY.md", content: "# Exported memory" },
      {
        path: "notes/profile.md",
        content: "Memory supporting note",
      },
    ];
    putMemoryArchive(misc, memoryS3Key, memoryFiles);
    await store.set(
      seedMemoryStorage$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        s3Key: memoryS3Key,
        headVersionId: memoryVersionId,
        fileCount: memoryFiles.length,
        size: memoryFiles.reduce((sum, file) => {
          return sum + Buffer.byteLength(file.content, "utf8");
        }, 0),
        updatedAt: new Date(exportStartAt),
      },
      context.signal,
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    const started = await api.requestPostUserExport(actor, [202]);
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    await waitForUserExportJobStatus(api, actor, jobId, "completed");
    const zip = exportZip(exportKey);
    const names = zipEntryNames(zip);

    const agentClaude = singleZipEntry(names, (name) => {
      return name.startsWith("agents/") && name.endsWith("/CLAUDE.md");
    });
    const agentCodex = singleZipEntry(names, (name) => {
      return name.startsWith("agents/") && name.endsWith("/AGENTS.md");
    });
    expect(zipText(zip, agentClaude)).toContain(
      "Use the exported agent instructions.",
    );
    expect(zipText(zip, agentCodex)).toContain(
      "Use the exported agent instructions.",
    );

    const workflowPrefix = `workflows/bdd-export-workflow-${workflowId}/`;
    const workflowSkill = singleZipEntry(names, (name) => {
      return name.startsWith(workflowPrefix) && name.endsWith("/SKILL.md");
    });
    const workflowNote = `${workflowPrefix}notes/checklist.md`;
    expect(zipText(zip, workflowSkill)).toContain(
      "Use the exported workflow instructions.",
    );
    expect(zipText(zip, workflowNote)).toBe("Workflow supporting file");
    expect(zipText(zip, `memory/${actor.orgId}/MEMORY.md`)).toBe(
      "# Exported memory",
    );
    expect(zipText(zip, `memory/${actor.orgId}/notes/profile.md`)).toBe(
      "Memory supporting note",
    );

    const conversation = JSON.parse(
      zipText(zip, `conversations/chat-thread-${threadId}.json`),
    ) as unknown;
    expect(conversation).toStrictEqual([
      {
        role: "user",
        content: "exported user text",
        createdAt: "2026-05-12T05:02:00.000Z",
      },
      {
        role: "assistant",
        content: "exported assistant text",
        createdAt: "2026-05-12T05:03:00.000Z",
      },
    ]);

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly agentInstructionFiles: number;
        readonly workflowFiles: number;
        readonly memoryFiles: number;
        readonly conversationThreads: number;
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts).toStrictEqual({
      agentInstructionFiles: 2,
      workflowFiles: 2,
      memoryFiles: 2,
      conversationThreads: 1,
      sessionHistories: 0,
    });
    expect(names).not.toContain("artifacts-manifest.json");
    expect(
      names.some((name) => {
        return name.endsWith(".tar.gz") || name.endsWith("-history.jsonl");
      }),
    ).toBeFalsy();
  });

  it("exports gzip-backed session history as a jsonl conversation file", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = await createUserExportActor(bdd);
    const exportStartAt = Date.UTC(2026, 4, 12, 6);
    const downloadUrl =
      "https://r2.example.com/bdd-export-history.zip?sig=test";

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = gzipSync(Buffer.from(history, "utf8"));
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        size: Buffer.byteLength(history, "utf8"),
        encoding: "gzip",
      },
      headers,
      [200],
    );
    expect(prepared.body).toMatchObject({
      existing: false,
      encoding: "gzip",
    });
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-export-session-${run.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      headers,
      [200],
    );
    if (checkpoint.status !== 200) {
      throw new Error("Expected gzip history checkpoint to succeed");
    }
    expect(checkpoint.body.conversationId).not.toBe("");
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0 },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    misc.putS3Object(compressedKey, compressedHistory);

    const started = await api.requestPostUserExport(actor, [202]);
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    await waitForUserExportJobStatus(api, actor, jobId, "completed");
    const zip = exportZip(exportKey);
    const names = zipEntryNames(zip);
    const historyEntry = singleZipEntry(names, (name) => {
      return (
        name.startsWith("conversations/") && name.endsWith("-history.jsonl")
      );
    });
    expect(zipText(zip, historyEntry)).toBe(history);

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly conversationThreads: number;
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts.conversationThreads).toBe(0);
    expect(manifest.counts.sessionHistories).toBe(1);
  });

  it("fails user export when gzip-backed session history does not match its hash", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = await createUserExportActor(bdd);
    const exportStartAt = Date.UTC(2026, 4, 12, 7);

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Corrupt History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint corrupt compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`;
    const tamperedHistory = history.replace("exported-", "tampered-");
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        size: Buffer.byteLength(history, "utf8"),
        encoding: "gzip",
      },
      headers,
      [200],
    );
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-export-corrupt-session-${run.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      headers,
      [200],
    );
    if (checkpoint.status !== 200) {
      throw new Error("Expected gzip history checkpoint to succeed");
    }
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0 },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-export-corrupt-history.zip?sig=test",
    );
    misc.putS3Object(
      compressedKey,
      gzipSync(Buffer.from(tamperedHistory, "utf8")),
    );

    const started = await api.requestPostUserExport(actor, [202]);
    const failedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "failed",
    );
    if (!failedStatus.job) {
      throw new Error("Expected failed export job");
    }
    expect(failedStatus.job.error).toContain("session history hash mismatch");
  });

  it("surfaces failed exports and allows an immediate retry", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = await createUserExportActor(bdd);
    const failedStartAt = Date.UTC(2026, 4, 20, 9);

    mockNow(failedStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-retry.zip?sig=test",
    );
    context.mocks.s3.send.mockRejectedValueOnce(new Error("S3 upload failed"));

    const failedStart = await api.requestPostUserExport(actor, [202]);

    const failedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      failedStart.body.jobId,
      "failed",
    );
    expect(failedStatus.job).toMatchObject({
      id: failedStart.body.jobId,
      status: "failed",
      error: "S3 upload failed",
      downloadUrl: null,
    });
    expect(failedStatus.canExport).toBeTruthy();
    expect(failedStatus.nextExportAt).toBeNull();

    mockNow(failedStartAt + 60_000);
    context.mocks.s3.send.mockResolvedValue({});
    const retried = await api.requestPostUserExport(actor, [202]);
    expect(retried.body.jobId).not.toBe(failedStart.body.jobId);

    const retriedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      retried.body.jobId,
      "completed",
    );
    expect(retriedStatus.job?.id).toBe(retried.body.jobId);
    expect(retriedStatus.job?.status).toBe("completed");
    expect(retriedStatus.canExport).toBeFalsy();
  });

  it("completes exports without an email for unsubscribed users", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = await createUserExportActor(bdd);

    await misc.requestEmailUnsubscribe(unsubscribeToken(actor.userId), [200]);

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-unsubscribed.zip?sig=test",
    );
    context.mocks.s3.send.mockResolvedValue({});
    const started = await api.requestPostUserExport(actor, [202]);

    const status = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    expect(status.job?.id).toBe(started.body.jobId);
    expect(status.job?.status).toBe("completed");
  });
});
