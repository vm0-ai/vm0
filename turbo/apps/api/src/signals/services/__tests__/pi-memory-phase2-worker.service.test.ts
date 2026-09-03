import { createHash, randomUUID } from "node:crypto";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { cronConsolidatePiMemoryPhase2Contract } from "@okouai/api-contracts/contracts/cron";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryPublicationProvenance } from "@okouai/db/schema/pi-memory-publication-provenance";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { memorySummaryProjections } from "@okouai/db/schema/memory-summary-projection";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { usageEvent } from "@okouai/db/schema/usage-event";
import type {
  PiMemoryPhase2ConsolidationResult,
  PiMemoryPhase2PreparedFile,
} from "@okouai/pi-agent-runtime/api";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { onTestFinished, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { db } from "../../../lib/db";
import { mockEnv } from "../../../lib/env";
import { withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedVm0BuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import { cronConsolidatePiMemoryPhase2RoutesForTest } from "../../routes/cron-consolidate-pi-memory-phase2";
import { createDeferredPromise } from "../../utils";
import {
  buildPiMemoryPhase2Archive,
  verifyPiMemoryPhase2Archive,
} from "../pi-memory-phase2-archive.service";
import {
  advancePiMemoryPhase2InputRevision,
  notifyPiMemoryPhase2ExternalHeadChange,
  PI_MEMORY_PHASE2_LEASE_DURATION_MS,
  PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
} from "../pi-memory-phase2-job.service";
import {
  executePiMemoryPhase2Work$,
  type PiMemoryPhase2WorkerResult,
} from "../pi-memory-phase2-worker.service";
import { computeContentHashFromHashes } from "../storage-content-hash.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2Candidates,
  insertPhase2StorageVersion,
  readPhase2Job,
  replacePhase2CandidateSource,
  setPhase2StorageHead,
  type Phase2TestScope,
} from "./pi-memory-phase2-job.test-fixture";

const BUCKET = "pi-memory-phase2-worker-test";
const NOW_MS = 1_788_408_000_000;
const DIGEST_ENCODING = "vm0.pi-memory.phase2.manifest.v1";
const MEMORY_SECRET = "PHASE2_MEMORY_CONTENT_SECRET_31291";
const PATH_SECRET = "unknown/path-secret-31291.txt";
const PROVIDER_ID_SECRET = "PHASE2_PROVIDER_ID_SECRET_31291";
const PROMPT_SECRET = "PHASE2_PROMPT_SECRET_31399";
const LAUNCH_SNAPSHOT_SECRET = "PHASE2_LAUNCH_SNAPSHOT_SECRET_31399";
const CRON_SECRET = "test-pi-memory-phase2-secret";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function preparedFile(
  path: string,
  content: string | Buffer,
): PiMemoryPhase2PreparedFile {
  const bytes = Buffer.isBuffer(content)
    ? Buffer.from(content)
    : Buffer.from(content, "utf8");
  return {
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    contentBase64: bytes.toString("base64"),
  };
}

function preparedDigest(files: readonly PiMemoryPhase2PreparedFile[]): string {
  const parts: Buffer[] = [uint32(files.length)];
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const hash = Buffer.from(file.hash, "utf8");
    parts.push(
      uint32(path.length),
      path,
      uint32(hash.length),
      hash,
      uint32(file.size),
    );
  }
  const version = Buffer.from(DIGEST_ENCODING, "utf8");
  return createHash("sha256")
    .update(Buffer.concat([uint32(version.length), version, ...parts]))
    .digest("hex");
}

function preparedResult(
  storageId: string,
  input: readonly Readonly<{
    readonly path: string;
    readonly content: string | Buffer;
  }>[],
): PiMemoryPhase2ConsolidationResult {
  const files = input
    .map((file) => {
      return preparedFile(file.path, file.content);
    })
    .sort((left, right) => {
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    });
  const metadata = files.map((file) => {
    return { path: file.path, hash: file.hash, size: file.size };
  });
  return {
    status: "prepared",
    files,
    manifest: {
      version: 1,
      files: metadata,
      fileCount: files.length,
      pathBytes: files.reduce((sum, file) => {
        return sum + Buffer.byteLength(file.path, "utf8");
      }, 0),
      totalBytes: files.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      digest: preparedDigest(files),
    },
    contentIdentity: computeContentHashFromHashes(storageId, metadata),
    diff: {
      added: 1,
      changed: 0,
      deleted: 0,
      renderedBytes: 0,
      truncated: false,
      digest: "d".repeat(64),
    },
    selectionDigest: "e".repeat(64),
    responseId: "fixture-response",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  };
}

function asyncBody(body: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function installS3(
  objects: Map<string, Buffer>,
  pauseFirstPut?: Readonly<{
    readonly started: Deferred<void>;
    readonly release: Promise<void>;
  }>,
): void {
  let firstPut = true;
  testContext().mocks.s3.send.mockImplementation(
    async (commandValue: unknown) => {
      if (commandValue instanceof PutObjectCommand) {
        const key = commandValue.input.Key;
        if (!key) {
          throw new Error("S3 test PUT has no key");
        }
        if (firstPut && pauseFirstPut) {
          firstPut = false;
          pauseFirstPut.started.resolve();
          await pauseFirstPut.release;
        }
        if (objects.has(key)) {
          const error = new Error("immutable object exists");
          error.name = "PreconditionFailed";
          throw error;
        }
        const body = commandValue.input.Body;
        if (typeof body !== "string" && !(body instanceof Uint8Array)) {
          throw new Error("S3 test PUT body is not bounded bytes");
        }
        objects.set(key, Buffer.from(body));
        return {};
      }
      if (commandValue instanceof GetObjectCommand) {
        const key = commandValue.input.Key;
        const body = key ? objects.get(key) : undefined;
        if (!body) {
          const error = new Error("object missing");
          error.name = "NotFound";
          throw error;
        }
        return { Body: asyncBody(body), ContentLength: body.length };
      }
      return {};
    },
  );
}

function usage() {
  return {
    input_tokens: 11,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 18,
  };
}

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function toolSse(index: number, path: string, content: string): string {
  const responseId = `resp_worker_tool_${index.toString()}`;
  const itemId = `fc_worker_${index.toString()}`;
  const callId = `call_worker_${index.toString()}`;
  const functionArguments = JSON.stringify({ path, content });
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name: "phase2_write",
    arguments: functionArguments,
    status: "completed",
  };
  return sse([
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: usage(),
      },
    },
  ]);
}

function textSse(index: number): string {
  const responseId = `${PROVIDER_ID_SECRET}_${index.toString()}`;
  const item = {
    type: "message",
    id: `msg_worker_${index.toString()}`,
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "maintenance complete", annotations: [] },
    ],
  };
  return sse([
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "maintenance complete",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: usage(),
      },
    },
  ]);
}

function installProvider(
  replay = false,
): Readonly<{ readonly calls: { value: number } }> {
  const calls = { value: 0 };
  server.use(
    http.post(
      /https:\/\/(?:api\.openai\.com|openrouter\.ai)\/.*\/responses/u,
      () => {
        const index = calls.value;
        calls.value += 1;
        const phase = replay ? index % 3 : index;
        const body =
          phase === 0
            ? toolSse(phase, "memory/MEMORY.md", `# ${MEMORY_SECRET}\n`)
            : phase === 1
              ? toolSse(
                  phase,
                  "memory/memory_summary.md",
                  "v1\n## User Profile\n- first Pi fact\n",
                )
              : textSse(phase);
        return new HttpResponse(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    ),
  );
  return { calls };
}

function installTextOnlyProvider(): Readonly<{
  readonly calls: { value: number };
}> {
  const calls = { value: 0 };
  server.use(
    http.post(
      /https:\/\/(?:api\.openai\.com|openrouter\.ai)\/.*\/responses/u,
      () => {
        const index = calls.value;
        calls.value += 1;
        return new HttpResponse(textSse(index), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    ),
  );
  return { calls };
}

function cleanupUsage(scope: Phase2TestScope): void {
  onTestFinished(async () => {
    await db()
      .delete(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, scope.orgId),
          eq(usageEvent.userId, scope.userId),
        ),
      );
  });
}

async function verifyStoredArchive(
  scope: Phase2TestScope,
  versionId: string,
  objects: ReadonlyMap<string, Buffer>,
) {
  const [version] = await db()
    .select({
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
    })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, scope.memoryStorageId),
        eq(storageVersions.id, versionId),
      ),
    );
  if (!version) {
    throw new Error("Stored Phase 2 version is missing");
  }
  const manifestBytes = objects.get(`${version.s3Key}/manifest.json`);
  const archiveBytes = objects.get(`${version.s3Key}/archive.tar.gz`);
  if (!manifestBytes || !archiveBytes) {
    throw new Error("Stored Phase 2 objects are missing");
  }
  return {
    version,
    archive: verifyPiMemoryPhase2Archive({
      storageId: scope.memoryStorageId,
      versionId,
      size: version.size,
      archiveSize: version.archiveSize,
      fileCount: version.fileCount,
      manifestBytes,
      archiveBytes,
    }),
  };
}

async function executeAt(args: {
  readonly store: ReturnType<typeof createStore>;
  readonly scope: Phase2TestScope;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<PiMemoryPhase2WorkerResult> {
  return await withMockNowForTest(args.currentTime, async () => {
    return (await args.store.set(
      executePiMemoryPhase2Work$,
      { scope: args.scope, currentTime: args.currentTime },
      args.signal,
    )) as PiMemoryPhase2WorkerResult;
  });
}

function phase2Routes(scope: Phase2TestScope) {
  return cronConsolidatePiMemoryPhase2RoutesForTest(scope);
}

function phase2Headers(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

async function executeRouteAt(args: {
  readonly scope: Phase2TestScope;
  readonly currentTime: Date;
  readonly signal?: AbortSignal;
}) {
  mockEnv("CRON_SECRET", CRON_SECRET);
  return await withMockNowForTest(args.currentTime, async () => {
    return await accept(
      setupApp({
        context: testContext(),
        routes: phase2Routes(args.scope),
        ...(args.signal ? { signal: args.signal } : {}),
      })(cronConsolidatePiMemoryPhase2Contract).consolidate({
        headers: phase2Headers(),
      }),
      [200],
    );
  });
}

describe("Pi memory Phase 2 worker composition", () => {
  it("authenticates the Phase 2 route before the disabled breaker", async () => {
    const context = testContext();
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    const provider = installProvider();
    const scope = await createPhase2TestScope("route-auth-first", {
      emptyBase: true,
    });
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "must remain pending",
        rolloutSummary: "must remain pending",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });
    context.mocks.s3.send.mockClear();

    const response = await accept(
      setupApp({ context, routes: phase2Routes(scope) })(
        cronConsolidatePiMemoryPhase2Contract,
      ).consolidate({ headers: phase2Headers("invalid-secret") }),
      [401],
    );

    expect(response.status).toBe(401);
    expect(provider.calls.value).toBe(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalledWith(
      "Pi memory background worker invocation disabled",
      expect.objectContaining({ route: "phase2", outcome: "disabled" }),
    );
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "pending",
      retryCount: 0,
    });
  });

  it("returns all-zero counters without touching durable state when disabled", async () => {
    const context = testContext();
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    const provider = installProvider();
    const objects = new Map<string, Buffer>();
    installS3(objects);
    const scope = await createPhase2TestScope("route-disabled", {
      emptyBase: true,
    });
    cleanupUsage(scope);
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: `${MEMORY_SECRET} ${PROMPT_SECRET}`,
        rolloutSummary: LAUNCH_SNAPSHOT_SECRET,
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });
    context.mocks.s3.send.mockClear();

    const response = await executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });

    expect(response.body).toStrictEqual({
      success: true,
      claimed: 0,
      noWork: 0,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });
    expect(provider.calls.value).toBe(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.debug).toHaveBeenCalledWith(
      "Pi memory background worker invocation disabled",
      expect.objectContaining({ route: "phase2", outcome: "disabled" }),
    );
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "pending",
      retryCount: 0,
      completedRevision: 0,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    const [storage] = await db()
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.id, scope.memoryStorageId));
    expect(storage?.headVersionId).toBe(scope.baseVersion.versionId);
    await expect(
      db()
        .select()
        .from(usageEvent)
        .where(
          and(
            eq(usageEvent.orgId, scope.orgId),
            eq(usageEvent.userId, scope.userId),
          ),
        ),
    ).resolves.toStrictEqual([]);

    const captured = JSON.stringify({
      body: response.body,
      logs: context.mocks.axiomLogging.debug.mock.calls,
    });
    expect(captured).not.toContain(MEMORY_SECRET);
    expect(captured).not.toContain(PROMPT_SECRET);
    expect(captured).not.toContain(LAUNCH_SNAPSHOT_SECRET);
    expect(captured).not.toContain(scope.baseVersion.s3Key);
    expect(captured).not.toContain(CRON_SECRET);
  });

  it("converges when Pi publishes before an external writer", async () => {
    const context = testContext();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    const provider = installProvider();
    const objects = new Map<string, Buffer>();
    installS3(objects);

    const persistedPrefix = `legacy/pi-first/${randomUUID()}`;
    const scope = await createPhase2TestScope("worker-pi-first", {
      emptyBase: true,
      s3Prefix: persistedPrefix,
    });
    cleanupUsage(scope);
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "first Pi durable fact",
        rolloutSummary: "first Pi durable evidence",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });

    const store = createStore();
    const first = await executeAt({
      store,
      scope,
      currentTime: new Date(NOW_MS),
      signal: context.signal,
    });
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") {
      throw new Error("Expected the first Pi publication");
    }
    const firstStored = await verifyStoredArchive(
      scope,
      first.publishedVersionId,
      objects,
    );
    expect(firstStored.version.s3Key).toBe(
      `${persistedPrefix}/${first.publishedVersionId}`,
    );

    const externalFiles = [
      ...firstStored.archive.files.map((file) => {
        return { path: file.path, content: Buffer.from(file.bytes) };
      }),
      { path: ".git/config", content: "external Codex git state" },
      { path: "external-fact.md", content: "external durable fact" },
    ];
    const externalArchive = buildPiMemoryPhase2Archive(
      scope.memoryStorageId,
      preparedResult(scope.memoryStorageId, externalFiles),
    );
    const externalS3Key = `legacy/codex-writer/${externalArchive.versionId}`;
    objects.set(
      `${externalS3Key}/manifest.json`,
      externalArchive.manifestBytes,
    );
    objects.set(
      `${externalS3Key}/archive.tar.gz`,
      externalArchive.archiveBytes,
    );
    const externalVersion = await insertPhase2StorageVersion(
      scope,
      "pi-first-external",
      {
        versionId: externalArchive.versionId,
        s3Key: externalS3Key,
        size: externalArchive.size,
        archiveSize: externalArchive.archiveSize,
        fileCount: externalArchive.fileCount,
        createdBy: "external-writer",
      },
    );
    const externalTime = new Date(NOW_MS + 1);
    await setPhase2StorageHead(scope, externalVersion, externalTime);
    await db().transaction(async (tx) => {
      await notifyPiMemoryPhase2ExternalHeadChange(tx, {
        ...scope,
        observedHeadVersionId: externalVersion.versionId,
        changedAt: externalTime,
      });
    });
    const secondInputTime = new Date(NOW_MS + 2);
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        sourceCompletedAt: secondInputTime,
        rawMemory: "second Pi durable fact",
        rolloutSummary: "second Pi durable evidence",
      },
    ]);
    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: secondInputTime,
      });
    });

    const second = await executeAt({
      store,
      scope,
      currentTime: new Date(NOW_MS + 3),
      signal: context.signal,
    });
    expect(second.outcome).toBe("published");
    if (second.outcome !== "published") {
      throw new Error("Expected the reconciled Pi publication");
    }
    expect(provider.calls.value).toBe(4);
    const finalStored = await verifyStoredArchive(
      scope,
      second.publishedVersionId,
      objects,
    );
    expect(finalStored.version.s3Key).toBe(
      `${persistedPrefix}/${second.publishedVersionId}`,
    );
    const finalByPath = new Map(
      finalStored.archive.files.map((file) => {
        return [file.path, Buffer.from(file.bytes).toString("utf8")] as const;
      }),
    );
    expect(finalByPath.get(".git/config")).toBe("external Codex git state");
    expect(finalByPath.get("external-fact.md")).toBe("external durable fact");
    expect(finalByPath.get("MEMORY.md")).toContain(MEMORY_SECRET);
    expect(
      [...finalByPath.keys()].filter((path) => {
        return path.startsWith("rollout_summaries/pi/");
      }),
    ).toHaveLength(2);
    const [head] = await db()
      .select({ versionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.id, scope.memoryStorageId));
    expect(head?.versionId).toBe(second.publishedVersionId);
    const provenance = await db()
      .select({
        outcome: piMemoryPublicationProvenance.outcome,
        writer: piMemoryPublicationProvenance.writer,
      })
      .from(piMemoryPublicationProvenance)
      .where(
        eq(
          piMemoryPublicationProvenance.memoryStorageId,
          scope.memoryStorageId,
        ),
      );
    expect(provenance).toStrictEqual(
      expect.arrayContaining([
        { outcome: "published", writer: "pi" },
        { outcome: "published", writer: "reconciler" },
      ]),
    );
  });

  it("lets an external upload win, then reclaims its exact archive and converges", async () => {
    const context = testContext();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    const provider = installProvider();
    const objects = new Map<string, Buffer>();
    const uploadStarted = createDeferredPromise<void>(context.signal);
    const uploadRelease = createDeferredPromise<void>(context.signal);
    installS3(objects, {
      started: uploadStarted,
      release: uploadRelease.promise,
    });

    const persistedPrefix = `legacy/pi-memory/${randomUUID()}`;
    const scope = await createPhase2TestScope("worker-convergence", {
      emptyBase: true,
      s3Prefix: persistedPrefix,
    });
    onTestFinished(async () => {
      await db()
        .delete(usageEvent)
        .where(
          and(
            eq(usageEvent.orgId, scope.orgId),
            eq(usageEvent.userId, scope.userId),
          ),
        );
    });
    const piSessionId = randomUUID();
    await insertPhase2Candidates(scope, [
      {
        piSessionId,
        rawMemory: "first Pi raw fact",
        rolloutSummary: "first Pi rollout fact",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });

    const externalFiles = [
      { path: ".git/config", content: "codex git state" },
      { path: "MEMORY.md", content: "# External writer fact\n" },
      {
        path: "memory_summary.md",
        content: "v1\n## User Profile\n- external writer fact\n",
      },
      { path: "legacy-topic.md", content: "legacy flat fact" },
      { path: PATH_SECRET, content: "unknown external fact" },
      { path: "rollout_summaries/codex.md", content: "Codex flat evidence" },
      {
        path: "rollout_summaries/pi/older.md",
        content: "older nested Pi evidence",
      },
    ] as const;
    const externalArchive = buildPiMemoryPhase2Archive(
      scope.memoryStorageId,
      preparedResult(scope.memoryStorageId, externalFiles),
    );
    const externalS3Key = `legacy/external-memory/${externalArchive.versionId}`;
    objects.set(
      `${externalS3Key}/manifest.json`,
      externalArchive.manifestBytes,
    );
    objects.set(
      `${externalS3Key}/archive.tar.gz`,
      externalArchive.archiveBytes,
    );
    const externalVersion = await insertPhase2StorageVersion(
      scope,
      "external",
      {
        versionId: externalArchive.versionId,
        s3Key: externalS3Key,
        size: externalArchive.size,
        archiveSize: externalArchive.archiveSize,
        fileCount: externalArchive.fileCount,
        createdBy: "external-writer",
      },
    );

    const store = createStore();
    const firstPromise = executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });
    await uploadStarted.promise;

    const concurrent = await executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });
    expect(concurrent.body).toStrictEqual({
      success: true,
      claimed: 0,
      noWork: 1,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });

    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    const disabledWhileClaimed = await executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });
    expect(disabledWhileClaimed.body).toStrictEqual({
      success: true,
      claimed: 0,
      noWork: 0,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });

    await setPhase2StorageHead(scope, externalVersion, new Date(NOW_MS + 1));
    await db().transaction(async (tx) => {
      await notifyPiMemoryPhase2ExternalHeadChange(tx, {
        ...scope,
        observedHeadVersionId: externalVersion.versionId,
        changedAt: new Date(NOW_MS + 1),
      });
    });
    const replacementTime = new Date(NOW_MS + 2);
    const replacementHash = await replacePhase2CandidateSource({
      scope,
      piSessionId,
      sourceCompletedAt: replacementTime,
    });
    await db()
      .update(piMemoryStage1Candidates)
      .set({
        status: "succeeded",
        rawMemory: "replacement Pi raw fact",
        rolloutSummary: "replacement Pi rollout fact",
        generatedAt: replacementTime,
        updatedAt: replacementTime,
      })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, piSessionId),
        ),
      );
    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: replacementTime,
      });
    });
    uploadRelease.resolve();

    const firstResponse = await firstPromise;
    expect(firstResponse.body).toStrictEqual({
      success: true,
      claimed: 1,
      noWork: 0,
      noDiff: 0,
      published: 0,
      conflicted: 1,
      stale: 0,
      failed: 0,
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "pending",
      retryCount: 0,
      inputRevision: 3,
      completedRevision: 0,
      lastObservedHeadVersionId: externalVersion.versionId,
    });
    const [afterConflictCandidate] = await db()
      .select({
        sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
        selected: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, piSessionId),
        ),
      );
    expect(afterConflictCandidate).toStrictEqual({
      sourceHistoryHash: replacementHash,
      selected: null,
    });

    const secondTime = new Date(
      NOW_MS + PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS + 2,
    );
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
    const second = await executeAt({
      store,
      scope,
      currentTime: secondTime,
      signal: context.signal,
    });
    expect(second.outcome).toBe("published");
    if (second.outcome !== "published") {
      throw new Error("Expected converged publication");
    }
    expect(provider.calls.value).toBe(4);

    const [head] = await db()
      .select({ versionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.id, scope.memoryStorageId));
    expect(head?.versionId).toBe(second.publishedVersionId);
    const [version] = await db()
      .select({
        s3Key: storageVersions.s3Key,
        size: storageVersions.size,
        archiveSize: storageVersions.archiveSize,
        fileCount: storageVersions.fileCount,
      })
      .from(storageVersions)
      .where(eq(storageVersions.id, second.publishedVersionId));
    if (!version) {
      throw new Error("Published version is missing");
    }
    expect(version.s3Key).toBe(
      `${persistedPrefix}/${second.publishedVersionId}`,
    );
    const manifestBytes = objects.get(`${version.s3Key}/manifest.json`);
    const archiveBytes = objects.get(`${version.s3Key}/archive.tar.gz`);
    if (!manifestBytes || !archiveBytes) {
      throw new Error("Published immutable objects are missing");
    }
    const verified = verifyPiMemoryPhase2Archive({
      storageId: scope.memoryStorageId,
      versionId: second.publishedVersionId,
      size: version.size,
      archiveSize: version.archiveSize,
      fileCount: version.fileCount,
      manifestBytes,
      archiveBytes,
    });
    const finalPaths = verified.files.map((file) => {
      return file.path;
    });
    for (const file of externalFiles.filter((candidate) => {
      return !candidate.path.startsWith("rollout_summaries/pi/");
    })) {
      expect(finalPaths).toContain(file.path);
    }
    expect(finalPaths).not.toContain("rollout_summaries/pi/older.md");
    const nestedPiEvidence = verified.files.filter((file) => {
      return file.path.startsWith("rollout_summaries/pi/");
    });
    expect(nestedPiEvidence).toHaveLength(1);
    const [replacementPiEvidence] = nestedPiEvidence;
    if (!replacementPiEvidence) {
      throw new Error("Replacement Pi evidence is missing");
    }
    expect(Buffer.from(replacementPiEvidence.bytes).toString("utf8")).toContain(
      "replacement Pi rollout fact",
    );

    const [selectedCandidate] = await db()
      .select({
        selected: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
      );
    expect(selectedCandidate?.selected).toBe(replacementHash);
    const usageRows = await db()
      .select({ runId: usageEvent.runId })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, scope.orgId),
          eq(usageEvent.userId, scope.userId),
        ),
      );
    expect(usageRows).toHaveLength(8);
    expect(
      usageRows.every((row) => {
        return row.runId === null;
      }),
    ).toBeTruthy();
    const provenance = await db()
      .select({ outcome: piMemoryPublicationProvenance.outcome })
      .from(piMemoryPublicationProvenance)
      .where(
        eq(
          piMemoryPublicationProvenance.memoryStorageId,
          scope.memoryStorageId,
        ),
      );
    expect(provenance).toStrictEqual(
      expect.arrayContaining([
        { outcome: "conflicted" },
        { outcome: "published" },
      ]),
    );
    const projections = await db()
      .select({ versionId: memorySummaryProjections.storageVersionId })
      .from(memorySummaryProjections)
      .where(
        eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
      );
    expect(projections).toStrictEqual([
      { versionId: second.publishedVersionId },
    ]);

    const capturedLogs =
      JSON.stringify(context.mocks.axiomLogging.debug.mock.calls) +
      JSON.stringify(context.mocks.axiomLogging.info.mock.calls) +
      JSON.stringify(context.mocks.axiomLogging.warn.mock.calls);
    expect(capturedLogs).not.toContain(MEMORY_SECRET);
    expect(capturedLogs).not.toContain(PATH_SECRET);
    expect(capturedLogs).not.toContain(PROVIDER_ID_SECRET);
    expect(capturedLogs).not.toContain(PROMPT_SECRET);
    expect(capturedLogs).not.toContain(LAUNCH_SNAPSHOT_SECRET);
  });

  it("reuses a detached registered archive and provider usage after a stale replay", async () => {
    const context = testContext();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    const provider = installProvider(true);
    const objects = new Map<string, Buffer>();
    const uploadStarted = createDeferredPromise<void>(context.signal);
    const uploadRelease = createDeferredPromise<void>(context.signal);
    installS3(objects, {
      started: uploadStarted,
      release: uploadRelease.promise,
    });

    const scope = await createPhase2TestScope("worker-replay", {
      emptyBase: true,
      s3Prefix: `legacy/replay/${randomUUID()}`,
    });
    cleanupUsage(scope);
    const [sourceHistoryHash] = await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "replayed Pi raw fact",
        rolloutSummary: "replayed Pi evidence",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });

    const firstPromise = executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });
    await uploadStarted.promise;
    await db()
      .update(piMemoryPhase2Jobs)
      .set({ leaseToken: randomUUID() })
      .where(eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId));
    uploadRelease.resolve();
    const firstResponse = await firstPromise;
    expect(firstResponse.body).toStrictEqual({
      success: true,
      claimed: 1,
      noWork: 0,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 1,
      failed: 0,
    });
    const putCountAfterFirst = context.mocks.s3.send.mock.calls.filter(
      ([command]) => {
        return command instanceof PutObjectCommand;
      },
    ).length;
    expect(putCountAfterFirst).toBe(2);

    const detachedVersions = await db()
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.storageId, scope.memoryStorageId));
    expect(detachedVersions).toHaveLength(2);
    const detachedVersionId = detachedVersions.find((version) => {
      return version.id !== scope.baseVersion.versionId;
    })?.id;
    if (!detachedVersionId) {
      throw new Error("Expected one detached prepared version");
    }
    const firstUsage = await db()
      .select({ idempotencyKey: usageEvent.idempotencyKey })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, scope.orgId),
          eq(usageEvent.userId, scope.userId),
        ),
      );
    expect(firstUsage).toHaveLength(4);

    const retryTime = new Date(
      NOW_MS + PI_MEMORY_PHASE2_LEASE_DURATION_MS * 24,
    );
    const replay = await executeRouteAt({
      scope,
      currentTime: retryTime,
    });
    expect(replay.body).toStrictEqual({
      success: true,
      claimed: 1,
      noWork: 0,
      noDiff: 0,
      published: 1,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });
    expect(provider.calls.value).toBe(6);
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        return command instanceof PutObjectCommand;
      }),
    ).toHaveLength(putCountAfterFirst);

    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: new Date(retryTime.getTime() + 1),
      });
    });
    const noDiff = await executeRouteAt({
      scope,
      currentTime: new Date(
        retryTime.getTime() + PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS + 2,
      ),
    });
    expect(noDiff.body).toStrictEqual({
      success: true,
      claimed: 1,
      noWork: 0,
      noDiff: 1,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });
    expect(provider.calls.value).toBe(6);

    const versions = await db()
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.storageId, scope.memoryStorageId));
    expect(versions).toHaveLength(2);
    const usageRows = await db()
      .select({ runId: usageEvent.runId })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, scope.orgId),
          eq(usageEvent.userId, scope.userId),
        ),
      );
    expect(usageRows).toHaveLength(4);
    expect(
      usageRows.every((row) => {
        return row.runId === null;
      }),
    ).toBeTruthy();
    const provenance = await db()
      .select({ outcome: piMemoryPublicationProvenance.outcome })
      .from(piMemoryPublicationProvenance)
      .where(
        eq(
          piMemoryPublicationProvenance.memoryStorageId,
          scope.memoryStorageId,
        ),
      );
    expect(provenance).toStrictEqual([{ outcome: "published" }]);
    const projections = await db()
      .select({ versionId: memorySummaryProjections.storageVersionId })
      .from(memorySummaryProjections)
      .where(
        eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
      );
    expect(projections).toStrictEqual([{ versionId: detachedVersionId }]);
    const [candidate] = await db()
      .select({
        selected: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
      );
    expect(candidate?.selected).toBe(sourceHistoryHash);
  });

  it("persists terminal usage but publishes nothing after invalid provider output", async () => {
    const context = testContext();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    const provider = installTextOnlyProvider();
    const objects = new Map<string, Buffer>();
    installS3(objects);

    const scope = await createPhase2TestScope("worker-invalid-output", {
      emptyBase: true,
    });
    cleanupUsage(scope);
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "invalid-output raw fact",
        rolloutSummary: "invalid-output evidence",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });

    const response = executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });
    const routeResponse = await response;
    expect(routeResponse.body).toStrictEqual({
      success: true,
      claimed: 1,
      noWork: 0,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 1,
    });
    expect(provider.calls.value).toBe(1);
    const [storage] = await db()
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.id, scope.memoryStorageId));
    expect(storage?.headVersionId).toBe(scope.baseVersion.versionId);
    const versions = await db()
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.storageId, scope.memoryStorageId));
    expect(versions).toStrictEqual([{ id: scope.baseVersion.versionId }]);
    const usageRows = await db()
      .select({ runId: usageEvent.runId })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, scope.orgId),
          eq(usageEvent.userId, scope.userId),
        ),
      );
    expect(usageRows).toHaveLength(4);
    expect(
      usageRows.every((row) => {
        return row.runId === null;
      }),
    ).toBeTruthy();
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "retryable_failure",
      retryCount: 1,
      completedRevision: 0,
      lastErrorClass: "agent_output_invalid",
    });
    await expect(
      db()
        .select()
        .from(piMemoryPublicationProvenance)
        .where(
          eq(
            piMemoryPublicationProvenance.memoryStorageId,
            scope.memoryStorageId,
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db()
        .select()
        .from(memorySummaryProjections)
        .where(
          eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
        ),
    ).resolves.toHaveLength(0);
  });

  it("propagates abort and drains the claimed route before it settles", async () => {
    const context = testContext();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    mockEnv("CRON_SECRET", CRON_SECRET);
    await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    installS3(new Map<string, Buffer>());
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerAborted = createDeferredPromise<void>(context.signal);
    const providerRelease = createDeferredPromise<void>(context.signal);
    const providerFinished = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(
        /https:\/\/(?:api\.openai\.com|openrouter\.ai)\/.*\/responses/u,
        async ({ request }) => {
          request.signal.addEventListener(
            "abort",
            () => {
              providerAborted.resolve(undefined);
            },
            { once: true },
          );
          providerStarted.resolve(undefined);
          await providerRelease.promise;
          providerFinished.resolve(undefined);
          return new HttpResponse(textSse(0), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const scope = await createPhase2TestScope("route-abort", {
      emptyBase: true,
    });
    cleanupUsage(scope);
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "abort private memory",
        rolloutSummary: "abort private prompt",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });
    const controller = new AbortController();
    const abortError = new Error("caller disconnected");
    abortError.name = "AbortError";
    const responsePromise = withMockNowForTest(new Date(NOW_MS), async () => {
      return await setupRawAppRequest({
        context,
        routes: phase2Routes(scope),
        signal: controller.signal,
      })(cronConsolidatePiMemoryPhase2Contract.consolidate.path, {
        method: "GET",
        headers: phase2Headers(),
      });
    });

    await providerStarted.promise;
    controller.abort(abortError);
    await providerAborted.promise;
    providerRelease.resolve(undefined);
    await providerFinished.promise;
    const response = await responsePromise;

    expect(response.status).toBe(500);
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "retryable_failure",
      retryCount: 1,
      completedRevision: 0,
      lastErrorClass: "aborted",
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(
      db()
        .select()
        .from(usageEvent)
        .where(
          and(
            eq(usageEvent.orgId, scope.orgId),
            eq(usageEvent.userId, scope.userId),
          ),
        ),
    ).resolves.toStrictEqual([]);
  });

  it("fails closed when an exact registered non-empty base object is missing", async () => {
    const context = testContext();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    const objects = new Map<string, Buffer>();
    installS3(objects);
    const scope = await createPhase2TestScope("worker-missing-base");
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: "must not reach provider",
        rolloutSummary: "must not reach provider",
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 1,
      updatedAt: new Date(NOW_MS),
    });

    const response = executeAt({
      store: createStore(),
      scope,
      currentTime: new Date(NOW_MS),
      signal: context.signal,
    });
    await expect(response).resolves.toMatchObject({ outcome: "failed" });
    const [storage] = await db()
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.id, scope.memoryStorageId));
    expect(storage?.headVersionId).toBe(scope.baseVersion.versionId);
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "retryable_failure",
      retryCount: 1,
      completedRevision: 0,
    });
  });

  it("returns a successful no-op when no exact claim exists", async () => {
    const scope = await createPhase2TestScope("worker-no-work", {
      emptyBase: true,
    });
    const result = executeRouteAt({
      scope,
      currentTime: new Date(NOW_MS),
    });
    const response = await result;
    expect(response.body).toStrictEqual({
      success: true,
      claimed: 0,
      noWork: 1,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });
  });
});
