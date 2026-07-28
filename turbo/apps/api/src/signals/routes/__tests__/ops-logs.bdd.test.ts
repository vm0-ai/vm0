import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";

import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";

import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { cronAggregateModelStatsContract } from "@vm0/api-contracts/contracts/cron";
import { zeroAgentInstructionsContract } from "@vm0/api-contracts/contracts/zero-agents";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";

import { createAppWithRoutes } from "../../../app-factory-core";
import { env } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { accept, setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { modelStatsRoutes } from "../model-stats";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { commitMemoryVersion } from "./helpers/zero-memory";
import { createFixtureTracker } from "./helpers/zero-route-test";

/*
 * BILL-02 model stats and OPS-01 user export.
 *
 * This file is the SOLE OWNER of GET /api/cron/aggregate-model-stats:
 * the cron is a global sweep (window-scoped DELETE+reinsert over model_stat
 * plus an unconditional compact observation retention delete), so calling
 * it from any other test file would race this file's far-past observation
 * windows on the shared database — the same single-file-ownership rule as the
 * email drain / billing reconcile / screenshot cleanup crons (see the shared
 * cron auth helper in helpers/api-bdd-runs.ts).
 *
 * Shared-DB time design: the model-stats chain derives a random far-past UTC
 * day (2003-2009) per run and asserts rankings as baseline+delta, so leftovers
 * from interrupted past runs in a colliding window cannot flake assertions.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

interface DeferredS3Put {
  readonly resolve: () => void;
}

const context = testContext();
const trackDeferredS3Put = createFixtureTracker<DeferredS3Put>((pendingPut) => {
  pendingPut.resolve();
  return Promise.resolve();
});

afterEach(() => {
  clearMockNow();
});

async function entitledRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  createMiscRoutesApi(context);
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

function zipBytes(zip: AdmZip, name: string): Buffer {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`Expected ZIP entry ${name}`);
  }
  return entry.getData();
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
  status: "completed" | "failed",
) {
  await flushWaitUntilForTest();
  const response = await api.requestGetUserExport(actor, [200]);
  if (!("job" in response.body)) {
    throw new Error(`Expected user export job ${jobId} to become ${status}`);
  }
  expect(response.body.job).toMatchObject({ id: jobId, status });
  return response.body;
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
    const runs = createRunsApi(context);
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
    const compactIdempotencyKey = randomUUID();
    const compactBody = {
      runId: created.runId,
      events: [
        {
          idempotencyKey: compactIdempotencyKey,
          model,
          inputTokens: 300,
          outputTokens: 200,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 10,
        },
      ],
    };
    const duplicateWithinRequest =
      await webhooks.requestAgentModelUsageObservationV2Unchecked(
        {
          runId: created.runId,
          events: [compactBody.events[0], compactBody.events[0]],
        },
        sandboxHeaders,
        [400],
      );
    expect(duplicateWithinRequest.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const ingested = await webhooks.requestAgentModelUsageObservationV2(
      compactBody,
      sandboxHeaders,
      [200],
    );
    expect(ingested.body).toStrictEqual({ success: true });
    await webhooks.requestAgentModelUsageObservationV2(
      compactBody,
      sandboxHeaders,
      [200],
    );
    await Promise.all([
      webhooks.requestAgentModelUsageObservationV2(
        compactBody,
        sandboxHeaders,
        [200],
      ),
      webhooks.requestAgentModelUsageObservationV2(
        compactBody,
        sandboxHeaders,
        [200],
      ),
    ]);

    mockNow(previousObservedAt);
    await webhooks.requestAgentModelUsageObservationV2(
      {
        runId: created.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model,
            inputTokens: 80,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
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
    await webhooks.requestAgentModelUsageObservationV2(
      {
        runId: created.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model,
            inputTokens: 0,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
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

    // A failed rebuild must roll back the window DELETE. 1,024 maximum safe
    // integers still fit in PostgreSQL bigint; the 1,025th overflows SUM.
    mockNow(mainObservedAt);
    const overflowEvents = Array.from({ length: 1025 }, () => {
      return {
        idempotencyKey: randomUUID(),
        model,
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    });
    for (let offset = 0; offset < overflowEvents.length; offset += 100) {
      await webhooks.requestAgentModelUsageObservationV2(
        {
          runId: created.runId,
          events: overflowEvents.slice(offset, offset + 100),
        },
        sandboxHeaders,
        [200],
      );
    }

    mockNow(aggregateAt);
    const aggregateApp = createAppWithRoutes({
      signal: context.signal,
      routes: modelStatsRoutes,
    });
    const failedAggregate = await aggregateApp.request(
      `${cronAggregateModelStatsContract.aggregate.path}?hours=24`,
      {
        headers: { authorization: "Bearer test-cron-secret" },
      },
    );
    expect(failedAggregate.status).toBe(500);
    await expect(failedAggregate.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    const afterFailedRebuild = await api.readModelRankings("today");
    expect(afterFailedRebuild.body).toStrictEqual(reprocessed.body);

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
    const actor = bdd.user();
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

  it("exports the userMessage projection", async () => {
    const api = createOpsLogsApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledRunActor();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const userMessage: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "Export the structured request" },
      ],
    };
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "stale export content",
        generationTemplate,
        userMessage,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the structured message send to succeed");
    }

    const exportStartAt = Date.UTC(2026, 4, 12, 5, 30);
    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-structured-export.zip?sig=test",
    );
    const started = await api.requestPostUserExport(actor, [202]);
    const exportKey = `exports/${actor.userId}/${started.body.jobId}.zip`;
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );

    const messages = JSON.parse(
      zipText(
        exportZip(exportKey),
        `conversations/chat-thread-${sent.body.threadId}.json`,
      ),
    ) as {
      readonly role: string;
      readonly content: string;
      readonly userMessage?: UserMessageDocument;
    }[];
    expect(messages[0]).toMatchObject({
      role: "user",
      content: `[Template: ${style.title}]\n\nExport the structured request`,
      userMessage,
    });
    expect(messages[0]?.content).not.toContain("stale export content");
  });

  it("exports only agent instruction files, workflow files, and memory files", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = bdd.user();
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
    const memoryFiles = [
      { path: "MEMORY.md", content: "# Exported memory" },
      {
        path: "notes/profile.md",
        content: "Memory supporting note",
      },
    ];
    // Create the memory artifact head version through the product storage
    // upload flow, then place the mocked archive at the S3 key the product
    // assigned to it.
    const memory = await commitMemoryVersion(context, actor, memoryFiles);
    putMemoryArchive(misc, memory.s3Key, memoryFiles);

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
      conversationThreads: 0,
      sessionHistories: 0,
    });
    expect(names).not.toContain("artifacts-manifest.json");
    expect(
      names.some((name) => {
        return name.endsWith(".tar.gz") || name.endsWith("-history.jsonl");
      }),
    ).toBeFalsy();
  });

  it("exports gzip-backed session history bytes as a jsonl conversation file", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
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
    const history = Buffer.concat([
      Buffer.from(
        `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`,
        "utf8",
      ),
      Buffer.from([0xc3, 0x28, 0x0a]),
    ]);
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = gzipSync(history);
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: history.length,
        encodedSize: compressedHistory.length,
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
    expect(zipBytes(zip, historyEntry)).toStrictEqual(history);

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly conversationThreads: number;
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts.conversationThreads).toBe(0);
    expect(manifest.counts.sessionHistories).toBe(1);
  });

  it("exports zstd-backed session history bytes as a jsonl conversation file", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 6, 30);
    const downloadUrl =
      "https://r2.example.com/bdd-export-zstd-history.zip?sig=test";

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Zstd History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint zstd compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = Buffer.concat([
      Buffer.from(
        `{"type":"init"}\n{"type":"human","text":"zstd-exported-${randomUUID()}"}\n`,
        "utf8",
      ),
      Buffer.from([0xc3, 0x28, 0x0a]),
    ]);
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = zstdCompressSync(history);
    const compressedKey = `blobs/${historyHash}.blob.zst`;

    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: history.length,
        encodedSize: compressedHistory.length,
        encoding: "zstd",
      },
      headers,
      [200],
    );
    expect(prepared.body).toMatchObject({
      existing: false,
      encoding: "zstd",
    });
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-export-zstd-session-${run.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      headers,
      [200],
    );
    if (checkpoint.status !== 200) {
      throw new Error("Expected zstd history checkpoint to succeed");
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
    expect(zipBytes(zip, historyEntry)).toStrictEqual(history);

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
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
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
    const tamperedCompressedHistory = gzipSync(
      Buffer.from(tamperedHistory, "utf8"),
    );
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: tamperedCompressedHistory.length,
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
    misc.putS3Object(compressedKey, tamperedCompressedHistory);

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

  it("fails user export when zstd-backed session history does not match its hash", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 7, 30);

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Corrupt Zstd History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint corrupt zstd compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"zstd-exported-${randomUUID()}"}\n`;
    const tamperedHistory = history.replace("zstd-exported-", "zstd-tampered-");
    const historyHash = createHash("sha256").update(history).digest("hex");
    const tamperedCompressedHistory = zstdCompressSync(
      Buffer.from(tamperedHistory, "utf8"),
    );
    const compressedKey = `blobs/${historyHash}.blob.zst`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: tamperedCompressedHistory.length,
        encoding: "zstd",
      },
      headers,
      [200],
    );
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-export-corrupt-zstd-session-${run.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      headers,
      [200],
    );
    if (checkpoint.status !== 200) {
      throw new Error("Expected zstd history checkpoint to succeed");
    }
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0 },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-export-corrupt-zstd-history.zip?sig=test",
    );
    misc.putS3Object(compressedKey, tamperedCompressedHistory);

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

  it("fails user export when gzip-backed session history exceeds its encoded size", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 8);

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Oversized History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint oversized compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = gzipSync(Buffer.from(history, "utf8"));
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: compressedHistory.length,
        encoding: "gzip",
      },
      headers,
      [200],
    );
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-export-oversized-session-${run.runId}`,
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
      "https://r2.example.com/bdd-export-oversized-history.zip?sig=test",
    );
    misc.putS3Object(
      compressedKey,
      Buffer.concat([compressedHistory, Buffer.from([0])]),
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
    expect(failedStatus.job.error).toContain("S3 object is too large");
  });

  it("surfaces failed exports and allows an immediate retry", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
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
    const actor = bdd.user();

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
