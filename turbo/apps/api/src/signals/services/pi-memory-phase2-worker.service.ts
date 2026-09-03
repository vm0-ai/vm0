import { createHash, randomUUID } from "node:crypto";

import { getModelProviderPiEndpoint } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { storageVersions } from "@okouai/db/schema/storage";
import {
  PiMemoryPhase2EngineError,
  runPiMemoryPhase2Consolidation,
  type PiMemoryPhase2ConsolidationResult,
  type PiMemoryPhase2LifecycleEvent,
  type PiMemoryPhase2UsageEvent,
} from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { delay } from "signal-timers";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  putImmutableS3Object,
} from "../external/s3";
import { safeSync, settleIncludingAbort } from "../utils";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  buildPiMemoryPhase2Archive,
  PI_MEMORY_PHASE2_ARCHIVE_MAX_BYTES,
  PiMemoryPhase2ArchiveError,
  type PiMemoryPhase2ArchiveIdentity,
  PI_MEMORY_PHASE2_MANIFEST_MAX_BYTES,
  type PreparedPiMemoryPhase2Archive,
  verifyEmptyPiMemoryPhase2Version,
  verifyPiMemoryPhase2Archive,
} from "./pi-memory-phase2-archive.service";
import {
  claimPiMemoryPhase2Job,
  failPiMemoryPhase2Job,
  finalizePiMemoryPhase2Job,
  heartbeatPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
  piMemoryPhase2SelectionDigest,
} from "./pi-memory-phase2-job.service";
import {
  PI_MEMORY_PHASE2_MODEL,
  recordPiMemoryPhase2Usage,
} from "./pi-memory-phase2-usage.service";
import {
  registerPreparedStorageVersions,
  storageVersionMatches,
  type PreparedStorageVersion,
} from "./storage-version-registration.service";

const log = logger("PiMemoryPhase2Worker");
const PREPARED_VERSION_MESSAGE = "Pi memory Phase 2 consolidation";

interface PiMemoryPhase2WorkerScope {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface PiMemoryPhase2WorkerInput {
  readonly scope?: PiMemoryPhase2WorkerScope;
  readonly currentTime: Date;
}

export type PiMemoryPhase2WorkerResult =
  | { readonly outcome: "no_work" }
  | { readonly outcome: "no_diff"; readonly headVersionId: string }
  | { readonly outcome: "published"; readonly publishedVersionId: string }
  | { readonly outcome: "conflicted"; readonly currentHeadVersionId: string }
  | { readonly outcome: "stale" }
  | { readonly outcome: "failed"; readonly errorClass: string };

interface ExactLeaseFence extends PiMemoryPhase2WorkerScope {
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
}

class PiMemoryPhase2HeartbeatError extends Error {
  constructor(readonly errorClass: "heartbeat_failed" | "lease_lost") {
    super("Pi memory Phase 2 heartbeat failed");
    this.name = "PiMemoryPhase2HeartbeatError";
  }
}

class PiMemoryPhase2WorkerError extends Error {
  constructor(readonly errorClass: string) {
    super("Pi memory Phase 2 worker failed");
    this.name = "PiMemoryPhase2WorkerError";
  }
}

interface HeartbeatGuard {
  readonly operationSignal: AbortSignal;
  readonly cadenceController: AbortController;
  readonly monitor: Promise<void>;
  readonly removeCallerAbort: () => void;
  readonly failure: { value: PiMemoryPhase2HeartbeatError | undefined };
}

type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

function settleSync<T>(operation: () => T): OperationResult<T> {
  const result = safeSync(operation);
  return "ok" in result
    ? { ok: true, value: result.ok }
    : { ok: false, error: result.error };
}

async function startHeartbeatGuard(
  heartbeat: () => Promise<boolean>,
  callerSignal: AbortSignal,
): Promise<HeartbeatGuard> {
  callerSignal.throwIfAborted();
  const firstHeartbeat = await settleIncludingAbort(heartbeat());
  callerSignal.throwIfAborted();
  if (!firstHeartbeat.ok) {
    throw new PiMemoryPhase2HeartbeatError("heartbeat_failed");
  }
  if (!firstHeartbeat.value) {
    throw new PiMemoryPhase2HeartbeatError("lease_lost");
  }
  const operationController = new AbortController();
  const cadenceController = new AbortController();
  const failure: HeartbeatGuard["failure"] = { value: undefined };
  const abortOperation = () => {
    operationController.abort(callerSignal.reason);
    cadenceController.abort(callerSignal.reason);
  };
  callerSignal.addEventListener("abort", abortOperation, { once: true });
  const monitor = (async () => {
    while (!cadenceController.signal.aborted) {
      await settleIncludingAbort(
        delay(PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS, {
          signal: cadenceController.signal,
        }),
      );
      if (cadenceController.signal.aborted) {
        return;
      }
      const beat = await settleIncludingAbort(heartbeat());
      failure.value = beat.ok
        ? beat.value
          ? undefined
          : new PiMemoryPhase2HeartbeatError("lease_lost")
        : new PiMemoryPhase2HeartbeatError("heartbeat_failed");
      if (failure.value) {
        operationController.abort(failure.value);
        cadenceController.abort(failure.value);
      }
    }
  })();
  return {
    operationSignal: operationController.signal,
    cadenceController,
    monitor,
    removeCallerAbort() {
      callerSignal.removeEventListener("abort", abortOperation);
    },
    failure,
  };
}

async function finishHeartbeatGuard<T>(
  guard: HeartbeatGuard,
  operation: OperationResult<T>,
  callerSignal: AbortSignal,
): Promise<T> {
  const heartbeatFailureAtSettlement = guard.failure.value;
  const callerAbortedAtSettlement = callerSignal.aborted;
  guard.cadenceController.abort();
  await guard.monitor;
  guard.removeCallerAbort();
  if (heartbeatFailureAtSettlement) {
    throw heartbeatFailureAtSettlement;
  }
  if (callerAbortedAtSettlement) {
    callerSignal.throwIfAborted();
  }
  if (!operation.ok) {
    throw operation.error;
  }
  if (guard.failure.value) {
    throw guard.failure.value;
  }
  callerSignal.throwIfAborted();
  return operation.value;
}

function exactFence(
  claim: NonNullable<Awaited<ReturnType<typeof claimPiMemoryPhase2Job>>>,
  leaseOwner: string,
): ExactLeaseFence {
  return {
    memoryStorageId: claim.memoryStorageId,
    orgId: claim.orgId,
    userId: claim.userId,
    leaseOwner,
    leaseToken: claim.leaseToken,
    claimedRevision: claim.claimedRevision,
    claimedBaseVersionId: claim.baseVersion.versionId,
  };
}

function lifecycleLog(event: PiMemoryPhase2LifecycleEvent): void {
  log.debug("Pi memory Phase 2 engine lifecycle", {
    stage: event.stage,
    orgId: event.orgId,
    userId: event.userId,
    memoryStorageId: event.memoryStorageId,
    claimedRevision: event.claimedRevision,
    selectionDigest: event.selectionDigest,
    candidateCount: event.candidateCount,
    fileCount: event.fileCount,
    totalBytes: event.totalBytes,
    heartbeatCount: event.heartbeatCount,
    durationMs: event.durationMs,
    outcome: event.outcome,
    errorClass: event.errorClass,
    contentIdentity: event.contentIdentity,
  });
}

function providerConfig(args: {
  readonly route: NonNullable<
    Awaited<ReturnType<typeof resolveBuiltInModelRuntimeRoute>>
  >;
  readonly apiKey: string;
}) {
  const endpoint = getModelProviderPiEndpoint(
    args.route.providerType,
    "openai-responses",
  );
  const provider =
    args.route.providerType === "openai-api-key"
      ? "openai"
      : args.route.providerType === "openrouter-codex"
        ? "openrouter"
        : null;
  if (!endpoint || provider === null) {
    throw new PiMemoryPhase2WorkerError("model_route_unavailable");
  }
  return {
    provider,
    baseUrl: endpoint.baseUrl,
    apiKey: args.apiKey,
    model: args.route.upstreamModel,
    catalogModel: PI_MEMORY_PHASE2_MODEL,
    api: "openai-responses" as const,
    dialect: "openai-responses" as const,
    thinkingLevel: "medium" as const,
  };
}

async function resolveProviderConfig(db: Db, signal: AbortSignal) {
  const route = await resolveBuiltInModelRuntimeRoute(
    db,
    PI_MEMORY_PHASE2_MODEL,
  );
  signal.throwIfAborted();
  if (!route) {
    throw new PiMemoryPhase2WorkerError("model_route_unavailable");
  }
  const [key] = await db
    .select({ apiKey: builtInModelKeys.apiKey })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, route.modelKeyId))
    .limit(1);
  signal.throwIfAborted();
  if (!key) {
    throw new PiMemoryPhase2WorkerError("model_route_unavailable");
  }
  return providerConfig({ route, apiKey: key.apiKey });
}

function errorClass(error: unknown, signal: AbortSignal): string {
  if (error instanceof PiMemoryPhase2ArchiveError) {
    return error.errorClass;
  }
  if (error instanceof PiMemoryPhase2EngineError) {
    return error.errorClass;
  }
  if (error instanceof PiMemoryPhase2HeartbeatError) {
    return error.errorClass;
  }
  if (error instanceof PiMemoryPhase2WorkerError) {
    return error.errorClass;
  }
  return signal.aborted ? "aborted" : "worker_failed";
}

function logOutcome(args: {
  readonly claim: NonNullable<
    Awaited<ReturnType<typeof claimPiMemoryPhase2Job>>
  >;
  readonly leaseOwner: string;
  readonly outcome: PiMemoryPhase2WorkerResult["outcome"];
  readonly startedAt: number;
  readonly errorClass?: string;
  readonly versionId?: string;
}): void {
  log.info("Pi memory Phase 2 work completed", {
    orgId: args.claim.orgId,
    userId: args.claim.userId,
    memoryStorageId: args.claim.memoryStorageId,
    leaseOwner: args.leaseOwner,
    claimedRevision: args.claim.claimedRevision,
    claimedBaseVersionId: args.claim.baseVersion.versionId,
    selectedCount: args.claim.selected.length,
    outcome: args.outcome,
    errorClass: args.errorClass,
    versionId: args.versionId,
    durationMs: Math.max(0, Math.round(performance.now() - args.startedAt)),
    reconciliationLatencyMs:
      args.claim.reconciliationQueuedAt === null
        ? undefined
        : Math.max(
            0,
            nowDate().getTime() - args.claim.reconciliationQueuedAt.getTime(),
          ),
  });
}

type ClaimedJob = NonNullable<
  Awaited<ReturnType<typeof claimPiMemoryPhase2Job>>
>;
type PreparedEngineResult = Extract<
  PiMemoryPhase2ConsolidationResult,
  { readonly status: "prepared" }
>;

interface PreparedRegistration {
  readonly version: PreparedStorageVersion;
  readonly reused: boolean;
}

function heartbeatFor(db: Db, fence: ExactLeaseFence): () => Promise<boolean> {
  return async () => {
    return await heartbeatPiMemoryPhase2Job(db, {
      ...fence,
      currentTime: nowDate(),
    });
  };
}

const loadBaseArchive$ = command(
  async (
    { get },
    args: {
      readonly claim: ClaimedJob;
      readonly bucket: string;
      readonly heartbeat: () => Promise<boolean>;
    },
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2ArchiveIdentity> => {
    const base = args.claim.baseVersion;
    if (base.fileCount === 0) {
      return verifyEmptyPiMemoryPhase2Version({
        storageId: args.claim.memoryStorageId,
        versionId: base.versionId,
        size: base.size,
        archiveSize: base.archiveSize,
        fileCount: base.fileCount,
      });
    }
    const guard = await startHeartbeatGuard(args.heartbeat, signal);
    const manifest = await settleIncludingAbort(
      get(
        downloadS3BufferWithMaxBytes(
          args.bucket,
          `${base.s3Key}/manifest.json`,
          PI_MEMORY_PHASE2_MANIFEST_MAX_BYTES,
          guard.operationSignal,
        ),
      ),
    );
    if (signal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: signal.reason },
        signal,
      );
    }
    if (!manifest.ok) {
      return await finishHeartbeatGuard(guard, manifest, signal);
    }
    const archive = await settleIncludingAbort(
      get(
        downloadS3BufferWithMaxBytes(
          args.bucket,
          `${base.s3Key}/archive.tar.gz`,
          PI_MEMORY_PHASE2_ARCHIVE_MAX_BYTES,
          guard.operationSignal,
        ),
      ),
    );
    if (signal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: signal.reason },
        signal,
      );
    }
    if (!archive.ok) {
      return await finishHeartbeatGuard(guard, archive, signal);
    }
    if (guard.operationSignal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: guard.operationSignal.reason },
        signal,
      );
    }
    const verified = settleSync(() => {
      return verifyPiMemoryPhase2Archive({
        storageId: args.claim.memoryStorageId,
        versionId: base.versionId,
        size: base.size,
        archiveSize: base.archiveSize,
        fileCount: base.fileCount,
        manifestBytes: manifest.value,
        archiveBytes: archive.value,
      });
    });
    return await finishHeartbeatGuard(guard, verified, signal);
  },
);

function logVerifiedBase(
  claim: ClaimedJob,
  base: PiMemoryPhase2ArchiveIdentity,
): void {
  log.debug("Pi memory Phase 2 base archive verified", {
    orgId: claim.orgId,
    userId: claim.userId,
    memoryStorageId: claim.memoryStorageId,
    claimedRevision: claim.claimedRevision,
    versionId: base.versionId,
    fileCount: base.fileCount,
    totalBytes: base.size,
    archiveBytes: base.archiveSize,
  });
}

function responseIdentityHash(responseId: string): string {
  return createHash("sha256").update(responseId, "utf8").digest("hex");
}

function usageIdentityMatches(
  claim: ClaimedJob,
  event: PiMemoryPhase2UsageEvent,
): boolean {
  return (
    event.orgId === claim.orgId &&
    event.userId === claim.userId &&
    event.memoryStorageId === claim.memoryStorageId &&
    event.claimedRevision === claim.claimedRevision &&
    event.selectionDigest === piMemoryPhase2SelectionDigest(claim.selected)
  );
}

function usageObserver(db: Db, claim: ClaimedJob) {
  return async (event: PiMemoryPhase2UsageEvent): Promise<void> => {
    const responseIdHash = responseIdentityHash(event.responseId);
    if (!usageIdentityMatches(claim, event)) {
      log.warn("Pi memory Phase 2 usage identity rejected", {
        orgId: claim.orgId,
        userId: claim.userId,
        memoryStorageId: claim.memoryStorageId,
        claimedRevision: claim.claimedRevision,
        responseIdHash,
        errorClass: "usage_identity_mismatch",
      });
      throw new PiMemoryPhase2WorkerError("usage_identity_mismatch");
    }
    const recorded = await settleIncludingAbort(
      recordPiMemoryPhase2Usage(db, {
        memoryStorageId: claim.memoryStorageId,
        claimedRevision: claim.claimedRevision,
        selectionDigest: event.selectionDigest,
        orgId: claim.orgId,
        userId: claim.userId,
        responseId: event.responseId,
        usage: event.usage,
      }),
    );
    if (!recorded.ok) {
      log.warn("Pi memory Phase 2 usage persistence failed", {
        orgId: claim.orgId,
        userId: claim.userId,
        memoryStorageId: claim.memoryStorageId,
        claimedRevision: claim.claimedRevision,
        responseIdHash,
        errorClass:
          recorded.error instanceof Error &&
          recorded.error.message ===
            "Pi memory Phase 2 usage identity collision"
            ? "usage_identity_collision"
            : "usage_persistence_failure",
      });
      throw recorded.error;
    }
    log.debug("Pi memory Phase 2 usage persisted", {
      orgId: claim.orgId,
      userId: claim.userId,
      memoryStorageId: claim.memoryStorageId,
      claimedRevision: claim.claimedRevision,
      responseIdHash,
      inputTokens: event.usage.input,
      outputTokens: event.usage.output,
      cacheReadTokens: event.usage.cacheRead,
      cacheWriteTokens: event.usage.cacheWrite,
      reasoningTokens: event.usage.reasoning,
    });
  };
}

function validateEngineIdentity(
  claim: ClaimedJob,
  result: PiMemoryPhase2ConsolidationResult,
): void {
  if (
    result.selectionDigest !== piMemoryPhase2SelectionDigest(claim.selected)
  ) {
    throw new PiMemoryPhase2WorkerError("engine_identity_mismatch");
  }
}

async function runEngine(
  args: {
    readonly db: Db;
    readonly claim: ClaimedJob;
    readonly base: PiMemoryPhase2ArchiveIdentity;
    readonly heartbeat: () => Promise<boolean>;
  },
  signal: AbortSignal,
): Promise<PiMemoryPhase2ConsolidationResult> {
  const model = await resolveProviderConfig(args.db, signal);
  return await runPiMemoryPhase2Consolidation(
    {
      orgId: args.claim.orgId,
      userId: args.claim.userId,
      memoryStorageId: args.claim.memoryStorageId,
      claimedRevision: args.claim.claimedRevision,
      leaseToken: args.claim.leaseToken,
      baseFiles: args.base.files,
      selected: args.claim.selected,
      model,
      heartbeat: args.heartbeat,
      onLifecycle: lifecycleLog,
      onUsage: usageObserver(args.db, args.claim),
    },
    signal,
  );
}

interface UploadedArchiveBytes {
  readonly manifestBytes: Buffer;
  readonly archiveBytes: Buffer;
}

const uploadAndReadBackArchive$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly s3Key: string;
      readonly prepared: PreparedPiMemoryPhase2Archive;
      readonly upload: boolean;
    },
    signal: AbortSignal,
  ): Promise<UploadedArchiveBytes> => {
    if (args.upload) {
      await get(
        putImmutableS3Object(
          args.bucket,
          `${args.s3Key}/manifest.json`,
          args.prepared.manifestBytes,
          "application/json",
          signal,
        ),
      );
      signal.throwIfAborted();
      await get(
        putImmutableS3Object(
          args.bucket,
          `${args.s3Key}/archive.tar.gz`,
          args.prepared.archiveBytes,
          "application/gzip",
          signal,
        ),
      );
      signal.throwIfAborted();
    }
    const manifestBytes = await get(
      downloadS3BufferWithMaxBytes(
        args.bucket,
        `${args.s3Key}/manifest.json`,
        PI_MEMORY_PHASE2_MANIFEST_MAX_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    const archiveBytes = await get(
      downloadS3BufferWithMaxBytes(
        args.bucket,
        `${args.s3Key}/archive.tar.gz`,
        PI_MEMORY_PHASE2_ARCHIVE_MAX_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    return { manifestBytes, archiveBytes };
  },
);

function verifyUploadedArchive(args: {
  readonly storageId: string;
  readonly prepared: PreparedPiMemoryPhase2Archive;
  readonly uploaded: UploadedArchiveBytes;
}): PiMemoryPhase2ArchiveIdentity {
  if (
    !args.uploaded.manifestBytes.equals(args.prepared.manifestBytes) ||
    !args.uploaded.archiveBytes.equals(args.prepared.archiveBytes)
  ) {
    throw new PiMemoryPhase2ArchiveError("immutable_object_mismatch");
  }
  return verifyPiMemoryPhase2Archive({
    storageId: args.storageId,
    versionId: args.prepared.versionId,
    size: args.prepared.size,
    archiveSize: args.prepared.archiveSize,
    fileCount: args.prepared.fileCount,
    manifestBytes: args.uploaded.manifestBytes,
    archiveBytes: args.uploaded.archiveBytes,
  });
}

function preparedStorageVersion(args: {
  readonly claim: ClaimedJob;
  readonly s3Key: string;
  readonly verified: PiMemoryPhase2ArchiveIdentity;
}): PreparedStorageVersion {
  return {
    storageId: args.claim.memoryStorageId,
    versionId: args.verified.versionId,
    s3Key: args.s3Key,
    size: args.verified.size,
    archiveSize: args.verified.archiveSize,
    fileCount: args.verified.fileCount,
    message: PREPARED_VERSION_MESSAGE,
    createdBy: args.claim.userId,
  };
}

async function findRegisteredVersion(
  db: Db,
  versionId: string,
  signal: AbortSignal,
): Promise<PreparedStorageVersion | null> {
  const [version] = await db
    .select({
      storageId: storageVersions.storageId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .where(eq(storageVersions.id, versionId))
    .limit(1);
  signal.throwIfAborted();
  return version ?? null;
}

async function findReusableRegisteredVersion(
  args: { readonly db: Db; readonly expected: PreparedStorageVersion },
  signal: AbortSignal,
): Promise<PreparedStorageVersion | null> {
  const existing = await findRegisteredVersion(
    args.db,
    args.expected.versionId,
    signal,
  );
  if (existing && !storageVersionMatches(existing, args.expected)) {
    throw new PiMemoryPhase2ArchiveError("registered_metadata_mismatch");
  }
  return existing;
}

function buildPreparedArchive(
  claim: ClaimedJob,
  result: PreparedEngineResult,
): PreparedPiMemoryPhase2Archive {
  return buildPiMemoryPhase2Archive(claim.memoryStorageId, result);
}

const prepareAndRegister$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly claim: ClaimedJob;
      readonly result: PreparedEngineResult;
      readonly bucket: string;
      readonly heartbeat: () => Promise<boolean>;
    },
    signal: AbortSignal,
  ): Promise<PreparedRegistration> => {
    const guard = await startHeartbeatGuard(args.heartbeat, signal);
    const built = settleSync(() => {
      return buildPreparedArchive(args.claim, args.result);
    });
    if (!built.ok) {
      return await finishHeartbeatGuard(guard, built, signal);
    }
    if (guard.operationSignal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: guard.operationSignal.reason },
        signal,
      );
    }
    const prepared = built.value;
    const s3Key = `${args.claim.s3Prefix}/${prepared.versionId}`;
    const expectedVersion = preparedStorageVersion({
      claim: args.claim,
      s3Key,
      verified: prepared,
    });
    const existing = await settleIncludingAbort(
      findReusableRegisteredVersion(
        { db: args.db, expected: expectedVersion },
        guard.operationSignal,
      ),
    );
    if (signal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: signal.reason },
        signal,
      );
    }
    if (!existing.ok) {
      return await finishHeartbeatGuard(guard, existing, signal);
    }
    const uploaded = await settleIncludingAbort(
      set(
        uploadAndReadBackArchive$,
        {
          bucket: args.bucket,
          s3Key,
          prepared,
          upload: existing.value === null,
        },
        guard.operationSignal,
      ),
    );
    if (signal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: signal.reason },
        signal,
      );
    }
    if (!uploaded.ok) {
      return await finishHeartbeatGuard(
        guard,
        existing.value === null
          ? uploaded
          : {
              ok: false,
              error: new PiMemoryPhase2ArchiveError(
                "registered_object_unavailable",
              ),
            },
        signal,
      );
    }
    if (guard.operationSignal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: guard.operationSignal.reason },
        signal,
      );
    }
    const verified = settleSync(() => {
      return verifyUploadedArchive({
        storageId: args.claim.memoryStorageId,
        prepared,
        uploaded: uploaded.value,
      });
    });
    if (!verified.ok) {
      return await finishHeartbeatGuard(guard, verified, signal);
    }
    const version = preparedStorageVersion({
      claim: args.claim,
      s3Key,
      verified: verified.value,
    });
    const registered = await settleIncludingAbort(
      registerPreparedStorageVersions(
        { db: args.db, versions: [version] },
        guard.operationSignal,
      ),
    );
    if (signal.aborted) {
      return await finishHeartbeatGuard(
        guard,
        { ok: false, error: signal.reason },
        signal,
      );
    }
    if (!registered.ok) {
      return await finishHeartbeatGuard(guard, registered, signal);
    }
    return await finishHeartbeatGuard(
      guard,
      {
        ok: true,
        value: { version, reused: existing.value !== null },
      },
      signal,
    );
  },
);

function logPreparedArchive(
  claim: ClaimedJob,
  registration: PreparedRegistration,
): void {
  log.debug("Pi memory Phase 2 archive prepared and registered", {
    orgId: claim.orgId,
    userId: claim.userId,
    memoryStorageId: claim.memoryStorageId,
    claimedRevision: claim.claimedRevision,
    versionId: registration.version.versionId,
    fileCount: registration.version.fileCount,
    totalBytes: registration.version.size,
    archiveBytes: registration.version.archiveSize,
    reused: registration.reused,
  });
}

async function finalizeEngineResult(args: {
  readonly db: Db;
  readonly claim: ClaimedJob;
  readonly fence: ExactLeaseFence;
  readonly result: PiMemoryPhase2ConsolidationResult;
  readonly prepared?: PreparedStorageVersion;
}): Promise<PiMemoryPhase2WorkerResult> {
  if (args.result.status === "no_diff") {
    if (args.result.contentIdentity !== args.claim.baseVersion.versionId) {
      throw new PiMemoryPhase2WorkerError("no_diff_identity_mismatch");
    }
    return await finalizePiMemoryPhase2Job(args.db, {
      ...args.fence,
      currentTime: nowDate(),
      selected: args.claim.selected,
      result: { kind: "no_diff" },
    });
  }
  if (!args.prepared) {
    throw new PiMemoryPhase2WorkerError("prepared_version_missing");
  }
  return await finalizePiMemoryPhase2Job(args.db, {
    ...args.fence,
    currentTime: nowDate(),
    selected: args.claim.selected,
    result: { kind: "prepared", version: args.prepared },
  });
}

function outcomeVersion(
  result: PiMemoryPhase2WorkerResult,
): string | undefined {
  return result.outcome === "published"
    ? result.publishedVersionId
    : result.outcome === "conflicted"
      ? result.currentHeadVersionId
      : result.outcome === "no_diff"
        ? result.headVersionId
        : undefined;
}

const processClaim$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly claim: ClaimedJob;
      readonly fence: ExactLeaseFence;
      readonly heartbeat: () => Promise<boolean>;
    },
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    log.debug("Pi memory Phase 2 base archive loading", {
      orgId: args.claim.orgId,
      userId: args.claim.userId,
      memoryStorageId: args.claim.memoryStorageId,
      leaseOwner: args.fence.leaseOwner,
      claimedRevision: args.claim.claimedRevision,
      versionId: args.claim.baseVersion.versionId,
      fileCount: args.claim.baseVersion.fileCount,
      totalBytes: args.claim.baseVersion.size,
      archiveBytes: args.claim.baseVersion.archiveSize,
    });
    const base = await set(
      loadBaseArchive$,
      { claim: args.claim, bucket, heartbeat: args.heartbeat },
      signal,
    );
    logVerifiedBase(args.claim, base);
    const result = await runEngine({ ...args, base }, signal);
    validateEngineIdentity(args.claim, result);
    const registration =
      result.status === "prepared"
        ? await set(prepareAndRegister$, { ...args, result, bucket }, signal)
        : undefined;
    if (registration) {
      logPreparedArchive(args.claim, registration);
    }
    return await finalizeEngineResult({
      ...args,
      result,
      prepared: registration?.version,
    });
  },
);

export const executePiMemoryPhase2Work$ = command(
  async (
    { set },
    input: PiMemoryPhase2WorkerInput,
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult> => {
    const startedAt = performance.now();
    const leaseOwner = randomUUID();
    const db = set(writeDb$);
    signal.throwIfAborted();
    const claim = await claimPiMemoryPhase2Job(db, input);
    signal.throwIfAborted();
    if (!claim) {
      log.debug("Pi memory Phase 2 claim found no work", { leaseOwner });
      return { outcome: "no_work" };
    }
    const fence = exactFence(claim, leaseOwner);
    log.debug("Pi memory Phase 2 job claimed", {
      orgId: claim.orgId,
      userId: claim.userId,
      memoryStorageId: claim.memoryStorageId,
      leaseOwner,
      claimedRevision: claim.claimedRevision,
      claimedBaseVersionId: claim.baseVersion.versionId,
      selectedCount: claim.selected.length,
    });
    const processed = await settleIncludingAbort(
      set(
        processClaim$,
        {
          db,
          claim,
          fence,
          heartbeat: heartbeatFor(db, fence),
        },
        signal,
      ),
    );
    if (signal.aborted) {
      log.debug("Pi memory Phase 2 cancellation observed", {
        orgId: claim.orgId,
        userId: claim.userId,
        memoryStorageId: claim.memoryStorageId,
        claimedRevision: claim.claimedRevision,
        leaseOwner,
      });
    }
    if (processed.ok) {
      const response = processed.value;
      logOutcome({
        claim,
        leaseOwner,
        outcome: response.outcome,
        startedAt,
        versionId: outcomeVersion(response),
      });
      return response;
    }
    const failureClass = errorClass(processed.error, signal);
    const failureTransition = await settleIncludingAbort(
      failPiMemoryPhase2Job(db, {
        ...fence,
        currentTime: nowDate(),
        errorClass: failureClass,
      }),
    );
    if (signal.aborted) {
      log.debug("Pi memory Phase 2 cancellation persisted", {
        orgId: claim.orgId,
        userId: claim.userId,
        memoryStorageId: claim.memoryStorageId,
        claimedRevision: claim.claimedRevision,
        leaseOwner,
      });
    }
    if (!failureTransition.ok) {
      logOutcome({
        claim,
        leaseOwner,
        outcome: "failed",
        startedAt,
        errorClass: "failure_transition_failed",
      });
      signal.throwIfAborted();
      throw failureTransition.error;
    }
    const response: PiMemoryPhase2WorkerResult = failureTransition.value
      ? { outcome: "failed", errorClass: failureClass }
      : { outcome: "stale" };
    logOutcome({
      claim,
      leaseOwner,
      outcome: response.outcome,
      startedAt,
      errorClass: failureClass,
    });
    signal.throwIfAborted();
    return response;
  },
);
