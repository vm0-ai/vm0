import { createHash } from "node:crypto";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  type PiApiFirstTurnManifest,
  type PiApiFirstTurnOwnershipTransferMode,
  type PiResourceSnapshot,
  type SecretConnectorMetadata,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { modelProviderTypeSchema } from "@okouai/api-contracts/contracts/model-providers";
import { activeInputDeliveries } from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import {
  materializePiAgentModelConfig,
  type PiAgentCredentialReference,
  type PiAgentModelConfig,
} from "@okouai/pi-agent-runtime";
import {
  createPiApiFirstTurnOwnership,
  createPiSessionJsonl,
  classifyPiApiProviderFailure,
  inspectPiSessionJsonl,
  PiApiFirstTurnCompactionRequiredError,
  runPiApiFirstTurn,
  type PiApiFirstTurnOwnership,
  type PiApiFirstTurnResult,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import type { Tx } from "../../lib/db-types";
import type { AgentEvent } from "../../lib/event-consumer/verify";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { publishCancelToRunnerGroup } from "../external/realtime";
import {
  downloadS3BufferWithMaxBytes,
  putImmutableS3Object,
  putS3Object,
} from "../external/s3";
import {
  completeAgentRun$,
  type CompleteSideEffectsInput,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { createPiApiFirstTurnCheckpoint$ } from "./agent-webhook-checkpoints.service";
import {
  resolveCurrentModelProviderRuntimeSecretForApi,
  resolveModelProviderRuntimeSecretForApi,
} from "./agent-webhook-firewall-auth.service";
import {
  dispatchOptionalAgentEventConsumers$,
  receiveAgentEvents$,
} from "./agent-webhook-events.service";
import { decryptPersistentSecretsMap } from "./crypto.utils";
import {
  gunzipSessionHistoryBufferWithMaxBytes,
  unzstdSessionHistoryBufferWithMaxBytes,
} from "./session-history-decompression";
import {
  normalizeSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  resumeSessionHistoryRawBlobKey,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "./session-history-blobs";
import {
  piApiFirstTurnObjectKey,
  type PiApiFirstTurnActivation,
} from "./pi-api-first-turn-config";
import { recordPiApiFirstTurnUsage } from "./pi-api-first-turn-usage.service";
import {
  PiResourceSnapshotPreparationError,
  preparePiResourceSnapshot,
  UnsupportedPiResourceError,
} from "./pi-resource-snapshot.service";
import { lockPiApiFirstTurnLifecycle } from "./pi-api-first-turn-lifecycle.service";
import {
  awaitWithSignal,
  safeSync,
  settle,
  settleIncludingAbort,
  tapError,
} from "../utils";

const MODEL_COMMIT_BUDGET_MS = 2000;
const FAILURE_COMMIT_TIMEOUT_MS = 10_000;
const L = logger("pi-api-first-turn");

type PiApiFirstTurnErrorCode =
  | "PI_API_COMMIT_FAILED"
  | "PI_API_COMPACTION_PREFLIGHT_REQUIRED"
  | "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
  | "PI_API_FIRST_TURN_NOT_COMMITTABLE"
  | "PI_API_MODEL_FAILED"
  | "PI_API_MODEL_OUTPUT_INCOMPLETE"
  | "PI_API_MODEL_CREDENTIAL_INVALID"
  | "PI_API_PROMPT_UNSUPPORTED"
  | "PI_API_PREHEAT_FAILED"
  | "PI_API_RESOURCE_INVALID"
  | "PI_API_RESOURCE_PREPARATION_FAILED"
  | "PI_API_RESOURCE_UNSUPPORTED"
  | "PI_API_SANDBOX_FALLBACK_FAILED"
  | "PI_H0_DECOMPRESSION_FAILED"
  | "PI_H0_DOWNLOAD_FAILED"
  | "PI_H0_ENCODING_UNSUPPORTED"
  | "PI_H0_HASH_MISMATCH"
  | "PI_H0_JSONL_INVALID"
  | "PI_H0_METADATA_INVALID"
  | "PI_H0_SESSION_MISMATCH"
  | "PI_H0_SESSION_UNSUPPORTED"
  | "PI_H0_TOO_LARGE"
  | "PI_H1_INVALID"
  | "PI_H1_TOO_LARGE"
  | "PI_LAUNCH_CONFIG_INVALID";

class PiApiFirstTurnError extends Error {
  readonly code: PiApiFirstTurnErrorCode;
  readonly failureReason: RunFailureReasonToken | undefined;

  constructor(
    code: PiApiFirstTurnErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly failureReason?: RunFailureReasonToken;
    },
  ) {
    super(
      `[${code}] ${message}`,
      options && "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "PiApiFirstTurnError";
    this.code = code;
    this.failureReason = options?.failureReason;
  }
}

class PiApiFirstTurnActiveInputBeforeProviderError extends Error {
  constructor() {
    super("Active input committed before Pi provider ownership");
    this.name = "PiApiFirstTurnActiveInputBeforeProviderError";
  }
}

class PiApiFirstTurnCanonicalCancellationError extends Error {
  constructor() {
    super("Canonical Run cancellation owns the Pi API first turn");
    this.name = "PiApiFirstTurnCanonicalCancellationError";
  }
}

function piApiFirstTurnError(
  code: PiApiFirstTurnErrorCode,
  message: string,
  cause?: unknown,
  failureReason?: RunFailureReasonToken,
): PiApiFirstTurnError {
  return new PiApiFirstTurnError(
    code,
    message,
    cause === undefined && failureReason === undefined
      ? undefined
      : { cause, failureReason },
  );
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function decodeSessionHistory(args: {
  readonly encoded: Buffer;
  readonly encoding: string;
  readonly key: string;
}): Promise<Buffer> {
  switch (args.encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return await gunzipSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encoded,
        PI_API_FIRST_TURN_SESSION_MAX_BYTES,
      );
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return await unzstdSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encoded,
        PI_API_FIRST_TURN_SESSION_MAX_BYTES,
      );
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return args.encoded;
    }
    default: {
      throw piApiFirstTurnError(
        "PI_H0_ENCODING_UNSUPPORTED",
        "Pi H0 uses an unsupported encoding",
      );
    }
  }
}

interface LoadedResumeSession {
  readonly jsonl: string | undefined;
  readonly sha256: string | null;
}

function loadInlineResumeSession(sessionHistory: string): LoadedResumeSession {
  const bytes = Buffer.from(sessionHistory, "utf8");
  if (
    bytes.length === 0 ||
    bytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi H0 is empty or exceeds the API first-turn limit",
    );
  }
  return { jsonl: sessionHistory, sha256: sha256(bytes) };
}

const loadResumeSessionJsonl$ = command(async function loadResumeSessionJsonl(
  { get },
  args: {
    readonly db: Db;
    readonly resumeSession: StoredExecutionContext["resumeSession"];
  },
  signal: AbortSignal,
): Promise<LoadedResumeSession> {
  const resumeSession = args.resumeSession;
  if (!resumeSession) {
    return { jsonl: undefined, sha256: null };
  }
  if ("sessionHistory" in resumeSession) {
    return loadInlineResumeSession(resumeSession.sessionHistory);
  }

  const hash = resumeSession.historyRef.hash;
  const [metadata] = await args.db
    .select({
      rawSize: blobs.rawSize,
      encoding: blobs.encoding,
      encodedSize: blobs.encodedSize,
    })
    .from(blobs)
    .where(eq(blobs.hash, hash))
    .limit(1);
  signal.throwIfAborted();
  if (!metadata || metadata.rawSize <= 0 || metadata.encodedSize <= 0) {
    throw piApiFirstTurnError(
      "PI_H0_METADATA_INVALID",
      "Pi H0 metadata is unavailable or invalid",
    );
  }
  if (
    metadata.rawSize > PI_API_FIRST_TURN_SESSION_MAX_BYTES ||
    metadata.encodedSize > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi H0 exceeds the API first-turn limit",
    );
  }
  const normalizedEncoding = safeSync(() => {
    return normalizeSessionHistoryBlobEncoding(metadata.encoding);
  });
  if ("error" in normalizedEncoding) {
    throw piApiFirstTurnError(
      "PI_H0_ENCODING_UNSUPPORTED",
      "Pi H0 uses an unsupported encoding",
      normalizedEncoding.error,
    );
  }
  const encoding = normalizedEncoding.ok;
  const referencedEncoding =
    resumeSession.historyRef.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
  if (encoding !== referencedEncoding) {
    throw piApiFirstTurnError(
      "PI_H0_METADATA_INVALID",
      "Pi H0 encoding does not match the stored checkpoint reference",
    );
  }
  const key = resumeSessionHistoryBlobKey(hash, encoding);
  const downloaded = await settle(
    get(
      downloadS3BufferWithMaxBytes(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        key,
        metadata.encodedSize,
        signal,
      ),
    ),
    signal,
  );
  if (!downloaded.ok) {
    throw piApiFirstTurnError(
      "PI_H0_DOWNLOAD_FAILED",
      "Pi H0 download failed",
      downloaded.error,
    );
  }
  const encoded = downloaded.value;
  if (encoded.length !== metadata.encodedSize) {
    throw piApiFirstTurnError(
      "PI_H0_HASH_MISMATCH",
      "Pi H0 encoded size does not match its metadata",
    );
  }
  const decoded = await settle(
    decodeSessionHistory({ encoded, encoding, key }),
    signal,
  );
  if (!decoded.ok) {
    if (decoded.error instanceof PiApiFirstTurnError) {
      throw decoded.error;
    }
    throw piApiFirstTurnError(
      "PI_H0_DECOMPRESSION_FAILED",
      "Pi H0 decompression failed",
      decoded.error,
    );
  }
  const raw = decoded.value;
  if (raw.length !== metadata.rawSize || sha256(raw) !== hash) {
    throw piApiFirstTurnError(
      "PI_H0_HASH_MISMATCH",
      "Pi H0 failed its size or hash check",
    );
  }
  const decodedJsonl = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  });
  if ("error" in decodedJsonl) {
    throw piApiFirstTurnError(
      "PI_H0_JSONL_INVALID",
      "Pi H0 is not valid UTF-8 JSONL",
      decodedJsonl.error,
    );
  }
  return { jsonl: decodedJsonl.ok, sha256: hash };
});

function validateResumeSession(args: {
  readonly loaded: LoadedResumeSession;
  readonly expectedBaseSession: {
    readonly sessionId: string;
    readonly sha256: string | null;
  };
  readonly sessionId: string;
}): void {
  if (
    args.expectedBaseSession.sessionId !== args.sessionId ||
    args.expectedBaseSession.sha256 !== args.loaded.sha256
  ) {
    throw piApiFirstTurnError(
      "PI_H0_HASH_MISMATCH",
      "Pi H0 does not match the launch base checkpoint",
    );
  }
  if (args.loaded.jsonl === undefined) {
    return;
  }
  const parsed = safeSync(() => {
    return inspectPiSessionJsonl(args.loaded.jsonl ?? "");
  });
  if ("error" in parsed) {
    if (parsed.error instanceof UnsupportedPiSessionVersionError) {
      throw piApiFirstTurnError(
        "PI_H0_SESSION_UNSUPPORTED",
        "Pi H0 uses an unsupported session version",
        parsed.error,
      );
    }
    throw piApiFirstTurnError(
      "PI_H0_JSONL_INVALID",
      "Pi H0 is not a valid native Pi session",
      parsed.error,
    );
  }
  const session = parsed.ok;
  if (session.sessionId !== args.sessionId) {
    throw piApiFirstTurnError(
      "PI_H0_SESSION_MISMATCH",
      "Pi H0 session id does not match the launch session",
    );
  }
}

interface ApiFirstTurnLifecycleState {
  readonly activeDeliveryId: string | null;
  readonly chatThreadId: string | null;
  readonly orgId: string;
  readonly status: string;
  readonly userId: string;
}

async function readApiFirstTurnLifecycleState(
  tx: Tx,
  runId: string,
): Promise<ApiFirstTurnLifecycleState | null> {
  const [[run], [activeInput]] = await Promise.all([
    tx
      .select({
        status: agentRuns.status,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1),
    tx
      .select({ id: activeInputDeliveries.id })
      .from(activeInputDeliveries)
      .where(
        and(
          eq(activeInputDeliveries.runId, runId),
          eq(activeInputDeliveries.status, "open"),
        ),
      )
      .limit(1),
  ]);
  return run
    ? {
        ...run,
        activeDeliveryId: activeInput?.id ?? null,
      }
    : null;
}

function projectedAssistantBlocks(
  assistant: PiApiFirstTurnResult["assistantMessage"],
): unknown[] {
  return assistant.content.flatMap((block): unknown[] => {
    if (block.type === "text") {
      const text = block.text.trim();
      return text ? [{ type: "text", text }] : [];
    }
    if (block.type === "toolCall") {
      return [
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        },
      ];
    }
    return [];
  });
}

function assistantText(
  assistant: PiApiFirstTurnResult["assistantMessage"],
): string {
  return assistant.content
    .flatMap((block) => {
      return block.type === "text" && block.text.trim()
        ? [block.text.trim()]
        : [];
    })
    .join("\n\n");
}

function assistantEvents(
  runId: string,
  assistant: PiApiFirstTurnResult["assistantMessage"],
): AgentEvent[] {
  return projectedAssistantBlocks(assistant).map((block, sequenceNumber) => {
    return {
      type: "assistant",
      sequenceNumber,
      message: {
        id:
          assistant.responseId ??
          `${runId}:${assistant.timestamp}:${assistant.model}`,
        role: "assistant",
        content: [block],
        model: assistant.model,
        usage: {
          input_tokens: assistant.usage.input,
          output_tokens: assistant.usage.output,
          cache_read_input_tokens: assistant.usage.cacheRead,
          cache_creation_input_tokens: assistant.usage.cacheWrite,
        },
      },
    };
  });
}

function resultEvent(
  assistant: PiApiFirstTurnResult["assistantMessage"],
  startedAt: number,
  sequenceNumber: number,
): AgentEvent {
  return {
    type: "result",
    sequenceNumber,
    subtype: "success",
    is_error: false,
    result: assistantText(assistant),
    duration_ms: Math.max(0, now() - startedAt),
  };
}

const publishEvents$ = command(async function publishEvents(
  { set },
  args: {
    readonly auth: SandboxAuth;
    readonly events: readonly AgentEvent[];
  },
  signal: AbortSignal,
): Promise<void> {
  const result = await set(
    receiveAgentEvents$,
    { auth: args.auth, body: { runId: args.auth.runId, events: args.events } },
    signal,
  );
  if (result.response.status !== 200) {
    throw new Error("Pi API first-turn event projection was rejected");
  }
  if (result.acceptedEvents) {
    waitUntil(
      set(dispatchOptionalAgentEventConsumers$, result.acceptedEvents, signal),
    );
  }
});

const persistIdentitySessionBlob$ = command(
  async function persistIdentitySessionBlob(
    { get },
    args: {
      readonly db: Db;
      readonly hash: string;
      readonly bytes: Buffer;
    },
    signal: AbortSignal,
  ): Promise<void> {
    await args.db
      .insert(blobs)
      .values({
        hash: args.hash,
        rawSize: args.bytes.length,
        encoding: SESSION_HISTORY_ENCODING_IDENTITY,
        encodedSize: args.bytes.length,
        refCount: 0,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    await args.db
      .update(blobs)
      .set({
        rawSize: args.bytes.length,
        encoding: SESSION_HISTORY_ENCODING_IDENTITY,
        encodedSize: args.bytes.length,
      })
      .where(and(eq(blobs.hash, args.hash), eq(blobs.rawSize, 0)));
    signal.throwIfAborted();
    const [metadata] = await args.db
      .select({
        rawSize: blobs.rawSize,
        encoding: blobs.encoding,
        encodedSize: blobs.encodedSize,
      })
      .from(blobs)
      .where(eq(blobs.hash, args.hash))
      .limit(1);
    signal.throwIfAborted();
    if (
      metadata?.rawSize !== args.bytes.length ||
      metadata.encodedSize !== args.bytes.length ||
      metadata.encoding !== SESSION_HISTORY_ENCODING_IDENTITY
    ) {
      throw new Error("Pi API first-turn blob metadata is incompatible");
    }
    await get(
      putImmutableS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        resumeSessionHistoryRawBlobKey(args.hash),
        args.bytes,
        "application/octet-stream",
        signal,
      ),
    );
  },
);

const writeManifest$ = command(async function writeManifest(
  { get },
  args: {
    readonly runId: string;
    readonly manifest: PiApiFirstTurnManifest;
  },
  signal: AbortSignal,
): Promise<void> {
  await get(
    putS3Object(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      piApiFirstTurnObjectKey(args.runId, "manifest"),
      JSON.stringify(args.manifest),
      "application/json",
      signal,
    ),
  );
});

interface ApiFirstTurnContext {
  readonly db: Db;
  readonly activation: PiApiFirstTurnActivation;
}

interface PreparedApiFirstTurn {
  readonly apiStartTime: number;
  readonly auth: SandboxAuth;
  readonly baseSession: PiApiFirstTurnManifest["baseSession"];
  readonly commitIdentity: ApiFirstTurnCommitIdentity;
  readonly sessionBytes: Buffer;
  readonly sessionHash: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly turn: PiApiFirstTurnResult;
}

type ApiFirstTurnExecutionContext =
  PiApiFirstTurnActivation["executionContext"];
type ApiFirstTurnLaunchConfig =
  ApiFirstTurnExecutionContext["piLaunchConfig"]["apiFirstTurn"];

function piApiFirstTurnOutcomeTelemetry(
  executionContext: ApiFirstTurnExecutionContext,
) {
  const config = executionContext.piModelConfig;
  const dialect =
    "schemaVersion" in config
      ? config.dialect
      : (config.api ?? "openai-responses");
  const providerTypes = new Set(
    ("schemaVersion" in config ? config.credentialBindings : [])
      .map((binding) => {
        const providerType =
          executionContext.secretConnectorMap?.[binding.secretName];
        const metadata =
          executionContext.secretConnectorMetadataMap?.[binding.secretName];
        const parsed = modelProviderTypeSchema.safeParse(providerType);
        return parsed.success &&
          metadata?.sourceType === "model-provider" &&
          metadata.metadataKey === parsed.data
          ? parsed.data
          : null;
      })
      .filter((providerType) => {
        return providerType !== null;
      }),
  );
  const [productProvider] = providerTypes;
  return {
    dialect,
    executionOwner: "api-first" as const,
    ...(providerTypes.size === 1 && productProvider ? { productProvider } : {}),
  };
}

interface ApiFirstTurnCommitIdentity {
  readonly baseSessionId: string;
  readonly baseSessionSha256: string | null;
  readonly deadlineAt: number;
  readonly resourceSnapshotDigest: string;
  readonly sandboxEventSequenceStart: number;
  readonly sessionId: string;
}

function apiFirstTurnCommitIdentity(
  args: ApiFirstTurnContext,
): ApiFirstTurnCommitIdentity {
  const { launchConfig, sessionId } = validateApiFirstTurnLaunch(args);
  return {
    baseSessionId: launchConfig.baseSession.sessionId,
    baseSessionSha256: launchConfig.baseSession.sha256,
    deadlineAt: launchConfig.deadlineAt,
    resourceSnapshotDigest: launchConfig.resourceSnapshotDigest,
    sandboxEventSequenceStart: launchConfig.sandboxEventSequenceStart,
    sessionId,
  };
}

function sameApiFirstTurnCommitIdentity(
  left: ApiFirstTurnCommitIdentity,
  right: ApiFirstTurnCommitIdentity,
): boolean {
  return (
    left.baseSessionId === right.baseSessionId &&
    left.baseSessionSha256 === right.baseSessionSha256 &&
    left.deadlineAt === right.deadlineAt &&
    left.resourceSnapshotDigest === right.resourceSnapshotDigest &&
    left.sandboxEventSequenceStart === right.sandboxEventSequenceStart &&
    left.sessionId === right.sessionId
  );
}

async function withApiFirstTurnLifecycle<T>(
  args: ApiFirstTurnContext,
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  return await args.db.transaction(async (tx) => {
    await lockPiApiFirstTurnLifecycle(tx, args.activation.runId);
    return await operation(tx);
  });
}

function validateApiFirstTurnLaunch(args: ApiFirstTurnContext): {
  readonly executionContext: ApiFirstTurnExecutionContext;
  readonly launchConfig: ApiFirstTurnLaunchConfig;
  readonly sessionId: string;
} {
  const { executionContext } = args.activation;
  const launchConfig = executionContext.piLaunchConfig.apiFirstTurn;
  const sessionId = executionContext.piSessionId;
  if (launchConfig.baseSession.sessionId !== sessionId) {
    throw piApiFirstTurnError(
      "PI_LAUNCH_CONFIG_INVALID",
      "Pi launch base session id does not match the Pi session id",
    );
  }
  if (args.activation.prompt.trimStart().startsWith("/")) {
    throw piApiFirstTurnError(
      "PI_API_PROMPT_UNSUPPORTED",
      "Pi slash commands are not supported by the API first-turn slot",
    );
  }
  if (now() >= launchConfig.deadlineAt) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first-turn deadline elapsed before preparation",
    );
  }
  return { executionContext, launchConfig, sessionId };
}

function validateApiFirstTurnLifecycleCommit(
  args: ApiFirstTurnContext,
  state: ApiFirstTurnLifecycleState | null,
  expectedIdentity: ApiFirstTurnCommitIdentity,
  message: string,
): ApiFirstTurnLifecycleState {
  if (state?.status === "cancelled") {
    throw new PiApiFirstTurnCanonicalCancellationError();
  }
  if (
    !state ||
    (state.status !== "pending" && state.status !== "running") ||
    state.userId !== args.activation.userId ||
    state.orgId !== args.activation.orgId ||
    state.chatThreadId !== expectedIdentity.sessionId
  ) {
    throw piApiFirstTurnError("PI_API_FIRST_TURN_NOT_COMMITTABLE", message);
  }
  const currentIdentity = apiFirstTurnCommitIdentity(args);
  if (!sameApiFirstTurnCommitIdentity(currentIdentity, expectedIdentity)) {
    throw piApiFirstTurnError(
      "PI_LAUNCH_CONFIG_INVALID",
      "Pi API first-turn immutable launch identity changed before commit",
    );
  }
  if (now() + MODEL_COMMIT_BUDGET_MS >= expectedIdentity.deadlineAt) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first turn has no remaining commit budget",
    );
  }
  return state;
}

const loadApiFirstTurnResource$ = command(
  async function loadApiFirstTurnResource(
    { get },
    args: ApiFirstTurnContext,
    executionContext: ApiFirstTurnExecutionContext,
    expectedDigest: string,
    signal: AbortSignal,
  ): Promise<PiResourceSnapshot> {
    const prepared = await settle(
      get(
        preparePiResourceSnapshot(
          {
            db: args.db,
            mounts: executionContext.storageMounts,
            memoryRecall: executionContext.piLaunchConfig.memoryRecall,
          },
          signal,
        ),
      ),
      signal,
    );
    if (!prepared.ok) {
      if (prepared.error instanceof UnsupportedPiResourceError) {
        throw piApiFirstTurnError(
          "PI_API_RESOURCE_UNSUPPORTED",
          prepared.error.message,
          prepared.error,
        );
      }
      if (prepared.error instanceof PiResourceSnapshotPreparationError) {
        throw piApiFirstTurnError(
          "PI_API_RESOURCE_PREPARATION_FAILED",
          prepared.error.message,
          prepared.error,
        );
      }
      throw piApiFirstTurnError(
        "PI_API_RESOURCE_INVALID",
        "Pi resource snapshot could not be loaded strictly",
        prepared.error,
      );
    }
    const preparedResource: {
      readonly digest: string;
      readonly snapshot: PiResourceSnapshot;
    } = prepared.value;
    if (preparedResource.digest !== expectedDigest) {
      throw piApiFirstTurnError(
        "PI_API_RESOURCE_INVALID",
        "Pi resource snapshot digest does not match the launch config",
      );
    }
    return preparedResource.snapshot;
  },
);

interface CodexSubscriptionCredentialReference {
  readonly binding: PiAgentCredentialReference;
  readonly providerKey: "codex-oauth-token";
  readonly metadata: SecretConnectorMetadata & {
    readonly sourceType: "model-provider";
    readonly sourceUserId: string;
    readonly sourceId: string;
    readonly metadataKey: "codex-oauth-token";
  };
}

function sameCredentialSource(
  left: SecretConnectorMetadata,
  right: SecretConnectorMetadata,
): boolean {
  return (
    left.sourceType === right.sourceType &&
    left.sourceUserId === right.sourceUserId &&
    left.sourceId === right.sourceId &&
    left.metadataKey === right.metadataKey
  );
}

function codexSubscriptionCredentialReferences(args: {
  readonly activation: PiApiFirstTurnActivation;
  readonly executionContext: ApiFirstTurnExecutionContext;
}): {
  readonly accessToken: CodexSubscriptionCredentialReference;
  readonly accountId: CodexSubscriptionCredentialReference;
} | null {
  const config = args.executionContext.piModelConfig;
  if (
    !("schemaVersion" in config) ||
    config.dialect !== "openai-codex-responses"
  ) {
    return null;
  }
  const reference = (
    kind: PiAgentCredentialReference["kind"],
  ): CodexSubscriptionCredentialReference => {
    const binding = config.credentialBindings.find((candidate) => {
      return candidate.kind === kind;
    });
    if (!binding) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn subscription binding is missing",
      );
    }
    const providerKey =
      args.executionContext.secretConnectorMap?.[binding.secretName];
    const metadata =
      args.executionContext.secretConnectorMetadataMap?.[binding.secretName];
    if (
      providerKey !== "codex-oauth-token" ||
      metadata?.sourceType !== "model-provider" ||
      metadata.sourceUserId !== args.activation.userId ||
      !metadata.sourceId ||
      metadata.metadataKey !== "codex-oauth-token"
    ) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn subscription binding is not exact-account scoped",
      );
    }
    return {
      binding,
      providerKey,
      metadata: {
        ...metadata,
        sourceType: "model-provider",
        sourceUserId: metadata.sourceUserId,
        sourceId: metadata.sourceId,
        metadataKey: "codex-oauth-token",
      },
    };
  };
  const accessToken = reference("access-token");
  const accountId = reference("account-id");
  if (!sameCredentialSource(accessToken.metadata, accountId.metadata)) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription bindings do not share one account",
    );
  }
  return { accessToken, accountId };
}

function runtimeCredentialLookupArgs(
  args: ApiFirstTurnContext,
  reference: CodexSubscriptionCredentialReference,
) {
  return {
    db: args.db,
    orgId: args.activation.orgId,
    userId: args.activation.userId,
    key: reference.binding.secretName,
    providerKey: reference.providerKey,
    metadata: reference.metadata,
    featureSwitchContext: {
      userId: args.activation.userId,
      orgId: args.activation.orgId,
    },
  };
}

async function resolveCodexSubscriptionCredentials(
  args: ApiFirstTurnContext,
  references: NonNullable<
    ReturnType<typeof codexSubscriptionCredentialReferences>
  >,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const accessTokenResolution = await settle(
    resolveCurrentModelProviderRuntimeSecretForApi(
      runtimeCredentialLookupArgs(args, references.accessToken),
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!accessTokenResolution.ok) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription access token refresh failed",
      accessTokenResolution.error,
    );
  }
  const accessToken = accessTokenResolution.value;
  if (accessToken.status === "unavailable") {
    const reconnectRequired =
      accessToken.reconnectState === null ||
      accessToken.reconnectState.needsReconnect;
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription access token is unavailable",
      undefined,
      reconnectRequired ? "reconnect_required" : undefined,
    );
  }

  // Deliberately read only after access-token refresh, using the already
  // validated immutable sourceId rather than resolving the active account.
  const accountIdResolution = await settle(
    resolveModelProviderRuntimeSecretForApi(
      runtimeCredentialLookupArgs(args, references.accountId),
    ),
  );
  signal.throwIfAborted();
  if (!accountIdResolution.ok) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription account lookup failed",
      accountIdResolution.error,
    );
  }
  const accountId = accountIdResolution.value;
  if (!accessToken.value.trim() || !accountId?.trim()) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription credential is unavailable",
      undefined,
      "reconnect_required",
    );
  }
  return new Map([
    [references.accessToken.binding.secretName, accessToken.value],
    [references.accountId.binding.secretName, accountId],
  ]);
}

async function apiFirstTurnModelConfig(
  args: ApiFirstTurnContext,
  executionContext: ApiFirstTurnExecutionContext,
  signal: AbortSignal,
): Promise<PiAgentModelConfig> {
  const modelConfig = executionContext.piModelConfig;
  const subscriptionReferences = codexSubscriptionCredentialReferences({
    activation: args.activation,
    executionContext,
  });
  const subscriptionCredentials = subscriptionReferences
    ? await resolveCodexSubscriptionCredentials(
        args,
        subscriptionReferences,
        signal,
      )
    : null;
  const decrypted = subscriptionReferences
    ? { ok: true as const, value: null }
    : await settle(
        decryptPersistentSecretsMap(executionContext.encryptedSecrets, {
          userId: args.activation.userId,
          orgId: args.activation.orgId,
        }),
      );
  if (!decrypted.ok) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn encrypted model credentials are invalid",
      decrypted.error,
    );
  }
  const secrets: Record<string, string> | null = decrypted.value;
  return await materializePiAgentModelConfig({
    config: modelConfig,
    target: "direct",
    async resolveCredential(binding: PiAgentCredentialReference) {
      let value = subscriptionCredentials?.get(binding.secretName);
      if (subscriptionCredentials && !value) {
        throw piApiFirstTurnError(
          "PI_API_MODEL_CREDENTIAL_INVALID",
          "Pi API first-turn subscription credential binding is invalid",
        );
      }
      value ??= secrets?.[binding.secretName];
      const providerKey =
        executionContext.secretConnectorMap?.[binding.secretName];
      const metadata =
        executionContext.secretConnectorMetadataMap?.[binding.secretName];
      if (!value && providerKey && metadata) {
        const resolved = await settle(
          resolveModelProviderRuntimeSecretForApi({
            db: args.db,
            orgId: args.activation.orgId,
            userId: args.activation.userId,
            key: binding.secretName,
            providerKey,
            metadata,
            featureSwitchContext: {
              userId: args.activation.userId,
              orgId: args.activation.orgId,
            },
          }),
        );
        if (!resolved.ok) {
          throw piApiFirstTurnError(
            "PI_API_MODEL_CREDENTIAL_INVALID",
            "Pi API first-turn model credential lookup failed",
            resolved.error,
          );
        }
        value = resolved.value ?? undefined;
      }
      if (!value?.trim()) {
        throw piApiFirstTurnError(
          "PI_API_MODEL_CREDENTIAL_INVALID",
          "Pi API first-turn model credential is unavailable",
        );
      }
      return value;
    },
  });
}

async function recordApiFirstTurnUsage(
  context: ApiFirstTurnContext,
  turn: PiApiFirstTurnResult,
): Promise<void> {
  const { activation } = context;
  await recordPiApiFirstTurnUsage(context.db, {
    runId: activation.runId,
    orgId: activation.orgId,
    userId: activation.userId,
    billableFirewalls: activation.executionContext.billableFirewalls,
    modelUsageProvider: activation.executionContext.modelUsageProvider,
    piProvider: activation.executionContext.piModelConfig.provider,
    requestedServiceTier: activation.executionContext.piModelConfig.serviceTier,
    turn,
  });
}

async function observeDiscardedProviderResult(
  operation: Promise<PiApiFirstTurnResult>,
  args: ApiFirstTurnContext,
  ownership: PiApiFirstTurnOwnership,
): Promise<void> {
  const late = await settleIncludingAbort(operation);
  if (late.ok) {
    await recordApiFirstTurnUsage(args, late.value);
    L.warn("Pi API first-turn outcome", {
      runId: args.activation.runId,
      ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
      outcome: "discarded_late_provider_result",
      reason: "aborted_execution",
      ownershipStage: ownership.stage,
    });
  }
}

function validateApiModelTurnOutcome(turn: PiApiFirstTurnResult): void {
  if (turn.assistantMessage.stopReason === "length" && !turn.handoffRequired) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_OUTPUT_INCOMPLETE",
      "Pi API first-turn model output is incomplete",
    );
  }
  if (
    turn.assistantMessage.stopReason === "error" ||
    turn.assistantMessage.stopReason === "aborted"
  ) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_FAILED",
      `Pi API first-turn model stopped with ${turn.assistantMessage.stopReason}`,
      undefined,
      turn.assistantMessage.failureReason,
    );
  }
}

async function executeApiModelTurn(
  args: {
    readonly activation: PiApiFirstTurnActivation;
    readonly context: ApiFirstTurnContext;
    readonly commitIdentity: ApiFirstTurnCommitIdentity;
    readonly launchConfig: ApiFirstTurnLaunchConfig;
    readonly model: PiAgentModelConfig;
    readonly resourceSnapshot: PiResourceSnapshot;
    readonly sessionJsonl: string;
    readonly sessionId: string;
    readonly ownership: PiApiFirstTurnOwnership;
  },
  signal: AbortSignal,
): Promise<{
  readonly startedAt: number;
  readonly turn: PiApiFirstTurnResult;
}> {
  const modelDeadline = args.launchConfig.deadlineAt - MODEL_COMMIT_BUDGET_MS;
  if (now() >= modelDeadline) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first turn has no remaining model commit budget",
    );
  }
  const startedAt = now();
  const modelSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, modelDeadline - now())),
  ]);
  const operation = runPiApiFirstTurn(
    {
      cwd: CANONICAL_WORKING_DIR,
      agentDir: PI_AGENT_DIR,
      sessionId: args.sessionId,
      sessionJsonl: args.sessionJsonl,
      prompt: args.activation.prompt,
      appendSystemPrompt: args.activation.appendSystemPrompt,
      model: args.model,
      resourceSnapshot: args.resourceSnapshot,
      ownership: args.ownership,
      onMemoryRecallOutcome(outcome) {
        L.debug("Pi memory recall outcome", {
          runId: args.activation.runId,
          ...outcome,
        });
      },
      providerRequestBoundary: async (markProviderRequestMayHaveStarted) => {
        await withApiFirstTurnLifecycle(args.context, async (tx) => {
          modelSignal.throwIfAborted();
          const state = validateApiFirstTurnLifecycleCommit(
            args.context,
            await readApiFirstTurnLifecycleState(tx, args.activation.runId),
            args.commitIdentity,
            "Pi API first turn lost eligibility before provider ownership",
          );
          if (state.activeDeliveryId) {
            throw new PiApiFirstTurnActiveInputBeforeProviderError();
          }
          modelSignal.throwIfAborted();
          markProviderRequestMayHaveStarted();
        });
      },
    },
    modelSignal,
  );
  const executed = await settleIncludingAbort(
    awaitWithSignal(operation, modelSignal),
  );
  if (!executed.ok) {
    if (modelSignal.aborted) {
      waitUntil(
        observeDiscardedProviderResult(operation, args.context, args.ownership),
      );
    }
    if (
      executed.error instanceof PiApiFirstTurnError ||
      executed.error instanceof PiApiFirstTurnActiveInputBeforeProviderError ||
      executed.error instanceof PiApiFirstTurnCanonicalCancellationError
    ) {
      throw executed.error;
    }
    if (executed.error instanceof UnsupportedPiResourceSnapshotError) {
      throw piApiFirstTurnError(
        "PI_API_PREHEAT_FAILED",
        executed.error.message,
        executed.error,
      );
    }
    if (executed.error instanceof PiApiFirstTurnCompactionRequiredError) {
      throw piApiFirstTurnError(
        "PI_API_COMPACTION_PREFLIGHT_REQUIRED",
        "Pi H0 requires official Sandbox compaction preflight",
        executed.error,
      );
    }
    throw piApiFirstTurnError(
      modelSignal.aborted
        ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
        : "PI_API_MODEL_FAILED",
      modelSignal.aborted
        ? "Pi API first-turn model deadline elapsed"
        : "Pi API first-turn model request failed",
      executed.error,
      modelSignal.aborted || args.model.provider !== "openai-codex"
        ? undefined
        : classifyPiApiProviderFailure(executed.error),
    );
  }
  const turn = executed.value;
  await recordApiFirstTurnUsage(args.context, turn);
  validateApiModelTurnOutcome(turn);
  return { startedAt, turn };
}

function validateApiFirstTurnH1(
  turn: PiApiFirstTurnResult,
  sessionId: string,
): { readonly sessionBytes: Buffer; readonly sessionHash: string } {
  const sessionBytes = Buffer.from(turn.sessionJsonl, "utf8");
  if (
    sessionBytes.length === 0 ||
    sessionBytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H1_TOO_LARGE",
      "Pi H1 is empty or exceeds the API first-turn limit",
    );
  }
  const parsed = safeSync(() => {
    return inspectPiSessionJsonl(turn.sessionJsonl);
  });
  if ("error" in parsed) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi API first turn produced an invalid H1 session",
      parsed.error,
    );
  }
  const committedSession = parsed.ok;
  if (committedSession.sessionId !== sessionId) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi H1 session id does not match the launch session",
    );
  }
  if (
    (turn.handoffRequired && !committedSession.hasPendingToolCalls) ||
    (!turn.handoffRequired && !committedSession.isSettledCheckpoint)
  ) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi H1 state does not match the API first-turn outcome",
    );
  }
  return { sessionBytes, sessionHash: sha256(sessionBytes) };
}

function ownershipTransferManifest(args: {
  readonly mode: PiApiFirstTurnOwnershipTransferMode;
  readonly baseSession: PiApiFirstTurnManifest["baseSession"];
  readonly session: {
    readonly sessionId: string;
    readonly sha256: string;
    readonly rawSize: number;
  };
  readonly sandboxEventSequenceStart: number;
}): PiApiFirstTurnManifest {
  return {
    schemaVersion: 3,
    outcome: "ownership-transfer",
    mode: args.mode,
    baseSession: args.baseSession,
    session: args.session,
    sandboxEventSequenceStart: args.sandboxEventSequenceStart,
  };
}

type PiSandboxFallbackReason =
  | "PI_API_COMPACTION_PREFLIGHT_REQUIRED"
  | "PI_API_PREHEAT_FAILED"
  | "PI_API_RESOURCE_PREPARATION_FAILED";

type PiSandboxFirstReason = PiSandboxFallbackReason | "active_input";

function eligibleSandboxFallbackReason(
  args: {
    readonly failure: PiApiFirstTurnError;
    readonly ownership: PiApiFirstTurnOwnership;
  },
  signal: AbortSignal,
): PiSandboxFallbackReason | null {
  if (signal.aborted || args.ownership.stage !== "pre-provider") {
    return null;
  }
  switch (args.failure.code) {
    case "PI_API_PREHEAT_FAILED":
    case "PI_API_COMPACTION_PREFLIGHT_REQUIRED":
    case "PI_API_RESOURCE_PREPARATION_FAILED": {
      return args.failure.code;
    }
    default: {
      return null;
    }
  }
}

function validateSandboxFallbackSession(
  sessionJsonl: string,
  sessionId: string,
): { readonly bytes: Buffer; readonly hash: string } {
  const bytes = Buffer.from(sessionJsonl, "utf8");
  if (
    bytes.length === 0 ||
    bytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi sandbox fallback H0 is empty or exceeds the API first-turn limit",
    );
  }
  const inspected = safeSync(() => {
    return inspectPiSessionJsonl(sessionJsonl);
  });
  if ("error" in inspected) {
    throw piApiFirstTurnError(
      "PI_H0_JSONL_INVALID",
      "Pi sandbox fallback H0 is not a valid native Pi session",
      inspected.error,
    );
  }
  if (inspected.ok.sessionId !== sessionId) {
    throw piApiFirstTurnError(
      "PI_H0_SESSION_MISMATCH",
      "Pi sandbox fallback H0 session id does not match the launch session",
    );
  }
  return { bytes, hash: sha256(bytes) };
}

function materializeApiFirstTurnH0(args: {
  readonly apiStartTime: number;
  readonly loadedSession: LoadedResumeSession;
  readonly sessionId: string;
}): string {
  return (
    args.loadedSession.jsonl ??
    createPiSessionJsonl({
      cwd: CANONICAL_WORKING_DIR,
      sessionId: args.sessionId,
      timestamp: new Date(args.apiStartTime).toISOString(),
    })
  );
}

/**
 * Intentional runtime ownership fallback for a real preparation failure. This
 * remains necessary while API preparation happens after durable activation;
 * parent issue #30564 owns that lifecycle boundary.
 */
const publishSandboxFallback$ = command(async function publishSandboxFallback(
  { get, set },
  args: ApiFirstTurnContext,
  reason: PiSandboxFirstReason,
  signal: AbortSignal,
): Promise<void> {
  const { executionContext, launchConfig, sessionId } =
    validateApiFirstTurnLaunch(args);
  const commitIdentity = apiFirstTurnCommitIdentity(args);
  signal.throwIfAborted();
  const loadedSession = await set(
    loadResumeSessionJsonl$,
    {
      db: args.db,
      resumeSession: executionContext.resumeSession,
    },
    signal,
  );
  validateResumeSession({
    loaded: loadedSession,
    expectedBaseSession: launchConfig.baseSession,
    sessionId,
  });
  const sessionJsonl = materializeApiFirstTurnH0({
    apiStartTime: executionContext.apiStartTime,
    loadedSession,
    sessionId,
  });
  const session = validateSandboxFallbackSession(sessionJsonl, sessionId);
  await withApiFirstTurnLifecycle(args, async (tx) => {
    signal.throwIfAborted();
    const state = validateApiFirstTurnLifecycleCommit(
      args,
      await readApiFirstTurnLifecycleState(tx, args.activation.runId),
      commitIdentity,
      "Pi sandbox-first transfer lost commit eligibility",
    );
    if (reason === "active_input" && !state.activeDeliveryId) {
      throw piApiFirstTurnError(
        "PI_API_FIRST_TURN_NOT_COMMITTABLE",
        "Pi active-input sandbox-first transfer lost its durable delivery",
      );
    }
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const sessionKey = piApiFirstTurnObjectKey(
      args.activation.runId,
      "session",
    );
    await get(
      putS3Object(
        bucket,
        sessionKey,
        session.bytes,
        "application/x-ndjson",
        signal,
      ),
    );
    signal.throwIfAborted();
    const uploaded = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        sessionKey,
        session.bytes.length,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      uploaded.length !== session.bytes.length ||
      sha256(uploaded) !== session.hash
    ) {
      throw piApiFirstTurnError(
        "PI_API_SANDBOX_FALLBACK_FAILED",
        "Pi sandbox fallback H0 failed read-after-write validation",
      );
    }
    const manifest = ownershipTransferManifest({
      mode: "sandbox-first",
      baseSession: launchConfig.baseSession,
      session: {
        sessionId,
        sha256: session.hash,
        rawSize: session.bytes.length,
      },
      sandboxEventSequenceStart: launchConfig.sandboxEventSequenceStart,
    });
    await set(
      writeManifest$,
      { runId: args.activation.runId, manifest },
      signal,
    );
  });
});

const prepareApiFirstTurn$ = command(async function prepareApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  ownership: PiApiFirstTurnOwnership,
  signal: AbortSignal,
): Promise<PreparedApiFirstTurn> {
  const { executionContext, launchConfig, sessionId } =
    validateApiFirstTurnLaunch(args);
  const commitIdentity = apiFirstTurnCommitIdentity(args);
  signal.throwIfAborted();
  const resourceSnapshot = await set(
    loadApiFirstTurnResource$,
    args,
    executionContext,
    launchConfig.resourceSnapshotDigest,
    signal,
  );
  signal.throwIfAborted();
  const model = await apiFirstTurnModelConfig(args, executionContext, signal);
  signal.throwIfAborted();
  const loadedSession = await set(
    loadResumeSessionJsonl$,
    {
      db: args.db,
      resumeSession: executionContext.resumeSession,
    },
    signal,
  );
  validateResumeSession({
    loaded: loadedSession,
    expectedBaseSession: launchConfig.baseSession,
    sessionId,
  });
  const sessionJsonl = materializeApiFirstTurnH0({
    apiStartTime: executionContext.apiStartTime,
    loadedSession,
    sessionId,
  });
  const { startedAt, turn } = await executeApiModelTurn(
    {
      activation: args.activation,
      context: args,
      commitIdentity,
      launchConfig,
      model,
      resourceSnapshot,
      sessionJsonl,
      sessionId,
      ownership,
    },
    signal,
  );
  signal.throwIfAborted();
  const { sessionBytes, sessionHash } = validateApiFirstTurnH1(turn, sessionId);
  signal.throwIfAborted();
  const auth: SandboxAuth = {
    userId: args.activation.userId,
    orgId: args.activation.orgId,
    runId: args.activation.runId,
  };
  return {
    apiStartTime: executionContext.apiStartTime,
    auth,
    baseSession: launchConfig.baseSession,
    commitIdentity,
    sessionBytes,
    sessionHash,
    sessionId,
    startedAt,
    turn,
  };
});

const persistCompleteTurnCheckpoint$ = command(
  async function persistCompleteTurnCheckpoint(
    { set },
    args: ApiFirstTurnContext,
    prepared: PreparedApiFirstTurn,
    signal: AbortSignal,
  ): Promise<void> {
    await set(
      persistIdentitySessionBlob$,
      {
        db: args.db,
        hash: prepared.sessionHash,
        bytes: prepared.sessionBytes,
      },
      signal,
    );
    const checkpoint = await set(
      createPiApiFirstTurnCheckpoint$,
      {
        auth: prepared.auth,
        body: {
          runId: args.activation.runId,
          cliAgentType: "pi",
          cliAgentSessionId: prepared.sessionId,
          cliAgentSessionHistoryHash: prepared.sessionHash,
        },
      },
      signal,
    );
    if (checkpoint.status !== 200) {
      throw new Error("Pi API first-turn checkpoint was rejected");
    }
  },
);

const finalizeCompleteTurn$ = command(async function finalizeCompleteTurn(
  { set },
  args: ApiFirstTurnContext,
  prepared: PreparedApiFirstTurn,
  lastEventSequence: number,
  signal: AbortSignal,
): Promise<CompleteSideEffectsInput | undefined> {
  const completion = await set(
    completeAgentRun$,
    {
      auth: prepared.auth,
      executionOwner: "api-first",
      body: {
        runId: args.activation.runId,
        exitCode: 0,
        lastEventSequence,
      },
    },
    signal,
  );
  if (completion.status !== 200) {
    throw new Error("Pi API first-turn completion was rejected");
  }
  return completion.sideEffects;
});

function stopPreparedSandbox(
  activation: PiApiFirstTurnActivation,
  terminalStatus: "completed" | "failed",
): void {
  waitUntil(
    tapError(
      publishCancelToRunnerGroup(
        activation.runnerGroup,
        activation.runId,
        "hard",
      ),
      (error) => {
        L.warn("Failed to stop the prepared Pi Sandbox after API terminal", {
          runId: activation.runId,
          terminalStatus,
          error,
        });
      },
    ),
  );
}

const commitApiFirstTurn$ = command(async function commitApiFirstTurn(
  { get, set },
  args: ApiFirstTurnContext,
  prepared: PreparedApiFirstTurn,
  signal: AbortSignal,
): Promise<CompleteSideEffectsInput | undefined> {
  return await withApiFirstTurnLifecycle(args, async (tx) => {
    signal.throwIfAborted();
    const state = validateApiFirstTurnLifecycleCommit(
      args,
      await readApiFirstTurnLifecycleState(tx, args.activation.runId),
      prepared.commitIdentity,
      "Pi API first turn lost commit eligibility after the provider request",
    );
    const hasActiveInput = state.activeDeliveryId !== null;
    const transferMode: PiApiFirstTurnOwnershipTransferMode | null = prepared
      .turn.handoffRequired
      ? "pending-tool-continuation"
      : hasActiveInput
        ? "settled-session-continuation"
        : null;

    await get(
      putS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        piApiFirstTurnObjectKey(args.activation.runId, "session"),
        prepared.sessionBytes,
        "application/x-ndjson",
        signal,
      ),
    );
    signal.throwIfAborted();

    const blockEvents = assistantEvents(
      args.activation.runId,
      prepared.turn.assistantMessage,
    );
    const nextSequenceNumber = blockEvents.length;
    if (
      transferMode &&
      nextSequenceNumber < prepared.commitIdentity.sandboxEventSequenceStart
    ) {
      throw piApiFirstTurnError(
        "PI_LAUNCH_CONFIG_INVALID",
        "Pi API first-turn event boundary precedes the immutable Sandbox boundary",
      );
    }
    const events = transferMode
      ? blockEvents
      : [
          ...blockEvents,
          resultEvent(
            prepared.turn.assistantMessage,
            prepared.startedAt,
            nextSequenceNumber,
          ),
        ];
    await set(publishEvents$, { auth: prepared.auth, events }, signal);
    if (transferMode) {
      const manifest = ownershipTransferManifest({
        mode: transferMode,
        baseSession: prepared.baseSession,
        session: {
          sessionId: prepared.sessionId,
          sha256: prepared.sessionHash,
          rawSize: prepared.sessionBytes.length,
        },
        sandboxEventSequenceStart: nextSequenceNumber,
      });
      await set(
        writeManifest$,
        { runId: args.activation.runId, manifest },
        signal,
      );
      L.debug("Pi API first-turn outcome", {
        runId: args.activation.runId,
        ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
        handoffOwner: "sandbox",
        outcome: "ownership_transfer",
        reason: hasActiveInput
          ? transferMode === "settled-session-continuation"
            ? "active_input_settled_session"
            : "active_input_pending_tool"
          : "pending_tool_continuation",
        ownershipStage: "provider-may-have-started",
      });
      return undefined;
    }

    await set(persistCompleteTurnCheckpoint$, args, prepared, signal);
    const sideEffects = await set(
      finalizeCompleteTurn$,
      args,
      prepared,
      nextSequenceNumber,
      signal,
    );
    stopPreparedSandbox(args.activation, "completed");
    L.debug("Pi API first-turn outcome", {
      runId: args.activation.runId,
      ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
      outcome: "api_completion",
      reason: "settled_session",
      ownershipStage: "provider-may-have-started",
    });
    return sideEffects;
  });
});

const executeApiFirstTurn$ = command(async function executeApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  ownership: PiApiFirstTurnOwnership,
  signal: AbortSignal,
): Promise<CompleteSideEffectsInput | undefined> {
  const prepared = await set(prepareApiFirstTurn$, args, ownership, signal);
  const committed = await settle(
    set(commitApiFirstTurn$, args, prepared, signal),
    signal,
  );
  if (!committed.ok) {
    if (
      committed.error instanceof PiApiFirstTurnError ||
      committed.error instanceof PiApiFirstTurnCanonicalCancellationError
    ) {
      throw committed.error;
    }
    throw piApiFirstTurnError(
      "PI_API_COMMIT_FAILED",
      "Pi API first-turn H1 commit failed",
      committed.error,
    );
  }
  return committed.value;
});

function normalizedApiFirstTurnFailure(
  error: unknown,
  signal: AbortSignal,
): PiApiFirstTurnError {
  if (error instanceof PiApiFirstTurnError) {
    return error;
  }
  return piApiFirstTurnError(
    signal.aborted
      ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
      : "PI_API_MODEL_FAILED",
    signal.aborted
      ? "Pi API first-turn deadline elapsed"
      : "Pi API first turn failed",
    error,
  );
}

function normalizedSandboxFallbackFailure(
  error: unknown,
  signal: AbortSignal,
): PiApiFirstTurnError {
  if (error instanceof PiApiFirstTurnError) {
    return error;
  }
  return piApiFirstTurnError(
    signal.aborted
      ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
      : "PI_API_SANDBOX_FALLBACK_FAILED",
    signal.aborted
      ? "Pi API first-turn deadline elapsed during sandbox fallback"
      : "Pi sandbox fallback publication failed",
    error,
  );
}

async function settleApiFirstTurnExecution<T>(
  execution: Promise<T>,
  signal: AbortSignal,
) {
  const executed = await settleIncludingAbort(execution);
  if (executed.ok || !signal.aborted) {
    return executed;
  }
  return {
    ok: false as const,
    error: signal.reason ?? executed.error,
  };
}

async function canonicalApiFirstTurnCancellationWon(
  args: ApiFirstTurnContext,
): Promise<boolean> {
  return await withApiFirstTurnLifecycle(args, async (tx) => {
    const state = await readApiFirstTurnLifecycleState(
      tx,
      args.activation.runId,
    );
    return state?.status === "cancelled";
  });
}

function logCanonicalApiFirstTurnCancellation(
  args: ApiFirstTurnContext,
  ownership: PiApiFirstTurnOwnership,
): void {
  L.debug("Pi API first-turn outcome", {
    runId: args.activation.runId,
    ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
    outcome: "canonical_cancellation",
    reason:
      ownership.stage === "pre-provider"
        ? "canonical_cancellation_before_provider_ownership"
        : "canonical_cancellation_after_provider_ownership",
    ownershipStage: ownership.stage,
  });
}

const failApiFirstTurn$ = command(async function failApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  failure: PiApiFirstTurnError,
  ownership: PiApiFirstTurnOwnership,
): Promise<DispatchCompleteSideEffectsInput | undefined> {
  const failureSignal = AbortSignal.timeout(FAILURE_COMMIT_TIMEOUT_MS);
  return await withApiFirstTurnLifecycle(args, async (tx) => {
    const state = await readApiFirstTurnLifecycleState(
      tx,
      args.activation.runId,
    );
    if (state?.status === "cancelled") {
      logCanonicalApiFirstTurnCancellation(args, ownership);
      return undefined;
    }
    if (!state || (state.status !== "pending" && state.status !== "running")) {
      return undefined;
    }
    const completion = await set(
      completeAgentRun$,
      {
        auth: {
          userId: args.activation.userId,
          orgId: args.activation.orgId,
          runId: args.activation.runId,
        },
        executionOwner: "api-first",
        body: {
          runId: args.activation.runId,
          exitCode: 1,
          error: failure.message,
          ...(failure.failureReason
            ? { failureReason: failure.failureReason }
            : {}),
        },
      },
      failureSignal,
    );
    failureSignal.throwIfAborted();
    if (completion.status !== 200) {
      throw new Error("Pi API first-turn failure transition was rejected");
    }
    stopPreparedSandbox(args.activation, "failed");
    return completion.sideEffects
      ? {
          ...completion.sideEffects,
          apiStartTime: args.activation.executionContext.apiStartTime,
        }
      : undefined;
  });
});

export const runPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ): Promise<DispatchCompleteSideEffectsInput | undefined> => {
    const context: ApiFirstTurnContext = { db: set(writeDb$), activation };
    const ownership = createPiApiFirstTurnOwnership();
    const executed = await settleApiFirstTurnExecution(
      set(executeApiFirstTurn$, context, ownership, signal),
      signal,
    );
    if (executed.ok) {
      return executed.value
        ? {
            ...executed.value,
            apiStartTime: activation.executionContext.apiStartTime,
          }
        : undefined;
    }
    const activeInputBeforeProvider =
      executed.error instanceof PiApiFirstTurnActiveInputBeforeProviderError;
    let failure = normalizedApiFirstTurnFailure(executed.error, signal);
    const resourceFallbackReason = activeInputBeforeProvider
      ? null
      : eligibleSandboxFallbackReason(
          {
            failure,
            ownership,
          },
          signal,
        );
    const sandboxFirstReason: PiSandboxFirstReason | null =
      activeInputBeforeProvider ? "active_input" : resourceFallbackReason;
    if (sandboxFirstReason) {
      const fallback = await settleApiFirstTurnExecution(
        set(publishSandboxFallback$, context, sandboxFirstReason, signal),
        signal,
      );
      if (fallback.ok) {
        L.debug("Pi API first-turn outcome", {
          runId: activation.runId,
          ...piApiFirstTurnOutcomeTelemetry(activation.executionContext),
          handoffOwner: "sandbox",
          outcome:
            sandboxFirstReason === "active_input"
              ? "ownership_transfer"
              : sandboxFirstReason === "PI_API_COMPACTION_PREFLIGHT_REQUIRED"
                ? "ownership_transfer"
                : "sandbox_fallback",
          reason:
            sandboxFirstReason === "active_input"
              ? "active_input_sandbox_first"
              : sandboxFirstReason === "PI_API_COMPACTION_PREFLIGHT_REQUIRED"
                ? "compaction_preflight"
                : sandboxFirstReason,
          ownershipStage: ownership.stage,
        });
        return undefined;
      }
      failure = normalizedSandboxFallbackFailure(fallback.error, signal);
    }
    if (await canonicalApiFirstTurnCancellationWon(context)) {
      if (
        executed.error instanceof PiApiFirstTurnCanonicalCancellationError &&
        ownership.stage === "provider-may-have-started"
      ) {
        L.warn("Pi API first-turn outcome", {
          runId: activation.runId,
          ...piApiFirstTurnOutcomeTelemetry(activation.executionContext),
          outcome: "discarded_late_provider_result",
          reason: "canonical_cancellation",
          ownershipStage: ownership.stage,
        });
      }
      logCanonicalApiFirstTurnCancellation(context, ownership);
      return undefined;
    }
    L.warn("Pi API first-turn outcome", {
      runId: activation.runId,
      ...piApiFirstTurnOutcomeTelemetry(activation.executionContext),
      outcome: "terminal_failure",
      reason: failure.code,
      ownershipStage: ownership.stage,
      ...(resourceFallbackReason
        ? { fallbackReason: resourceFallbackReason }
        : {}),
    });
    return set(failApiFirstTurn$, context, failure, ownership);
  },
);
