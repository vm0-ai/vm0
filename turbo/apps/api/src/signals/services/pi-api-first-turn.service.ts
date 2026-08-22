import { createHash } from "node:crypto";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  type PiApiFirstTurnManifest,
  type PiResourceSnapshot,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { activeInputDeliveries } from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import {
  MemoryPiSession,
  runPiApiFirstTurn,
  type PiApiFirstTurnResult,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "@okouai/pi-agent-runtime/node";
import { command, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
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
  dispatchCompleteSideEffects$,
} from "./agent-webhook-complete.service";
import { createAgentCheckpoint$ } from "./agent-webhook-checkpoints.service";
import { resolveModelProviderRuntimeSecretForApi } from "./agent-webhook-firewall-auth.service";
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
import {
  preparePiResourceSnapshot,
  UnsupportedPiResourceError,
} from "./pi-resource-snapshot.service";
import { safeSync, settle, settleIncludingAbort, tapError } from "../utils";

const MODEL_COMMIT_BUDGET_MS = 2000;
const FAILURE_COMMIT_TIMEOUT_MS = 10_000;
const L = logger("pi-api-first-turn");

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

type PiApiFirstTurnErrorCode =
  | "PI_API_COMMIT_FAILED"
  | "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
  | "PI_API_FIRST_TURN_NOT_COMMITTABLE"
  | "PI_API_MODEL_FAILED"
  | "PI_API_MODEL_CREDENTIAL_INVALID"
  | "PI_API_PROMPT_UNSUPPORTED"
  | "PI_API_RESOURCE_INVALID"
  | "PI_API_RESOURCE_UNSUPPORTED"
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

  constructor(
    code: PiApiFirstTurnErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options);
    this.name = "PiApiFirstTurnError";
    this.code = code;
  }
}

function piApiFirstTurnError(
  code: PiApiFirstTurnErrorCode,
  message: string,
  cause?: unknown,
): PiApiFirstTurnError {
  return new PiApiFirstTurnError(
    code,
    message,
    cause === undefined ? undefined : { cause },
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

async function loadResumeSessionJsonl(
  args: {
    readonly db: Db;
    readonly get: ComputedGetter;
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
    args.get(
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
}

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
    return MemoryPiSession.fromJsonl(args.loaded.jsonl ?? "");
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
  if (session.getSessionId() !== args.sessionId) {
    throw piApiFirstTurnError(
      "PI_H0_SESSION_MISMATCH",
      "Pi H0 session id does not match the launch session",
    );
  }
}

async function canCommitApiTurn(
  db: Db,
  runId: string,
  deadlineAt: number,
): Promise<boolean> {
  if (now() + MODEL_COMMIT_BUDGET_MS >= deadlineAt) {
    return false;
  }
  const [[run], [activeInput]] = await Promise.all([
    db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1),
    db
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
  return (
    (run?.status === "pending" || run?.status === "running") && !activeInput
  );
}

function projectedAssistantContent(
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

function assistantEvent(
  runId: string,
  assistant: PiApiFirstTurnResult["assistantMessage"],
): AgentEvent {
  return {
    type: "assistant",
    sequenceNumber: 0,
    message: {
      id:
        assistant.responseId ??
        `${runId}:${assistant.timestamp}:${assistant.model}`,
      role: "assistant",
      content: projectedAssistantContent(assistant),
      model: assistant.model,
      usage: {
        input_tokens: assistant.usage.input,
        output_tokens: assistant.usage.output,
        cache_read_input_tokens: assistant.usage.cacheRead,
        cache_creation_input_tokens: assistant.usage.cacheWrite,
      },
    },
  };
}

function resultEvent(
  assistant: PiApiFirstTurnResult["assistantMessage"],
  startedAt: number,
): AgentEvent {
  return {
    type: "result",
    sequenceNumber: 1,
    subtype: "success",
    is_error: false,
    result: assistantText(assistant),
    duration_ms: Math.max(0, now() - startedAt),
  };
}

async function publishEvents(
  args: {
    readonly set: Parameters<Parameters<typeof command>[0]>[0]["set"];
    readonly auth: SandboxAuth;
    readonly events: readonly AgentEvent[];
  },
  signal: AbortSignal,
): Promise<void> {
  const result = await args.set(
    receiveAgentEvents$,
    { auth: args.auth, body: { runId: args.auth.runId, events: args.events } },
    signal,
  );
  if (result.response.status !== 200) {
    throw new Error("Pi API first-turn event projection was rejected");
  }
  if (result.acceptedEvents) {
    waitUntil(
      args.set(
        dispatchOptionalAgentEventConsumers$,
        result.acceptedEvents,
        signal,
      ),
    );
  }
}

async function persistIdentitySessionBlob(
  args: {
    readonly db: Db;
    readonly get: ComputedGetter;
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
  await args.db
    .update(blobs)
    .set({
      rawSize: args.bytes.length,
      encoding: SESSION_HISTORY_ENCODING_IDENTITY,
      encodedSize: args.bytes.length,
    })
    .where(and(eq(blobs.hash, args.hash), eq(blobs.rawSize, 0)));
  const [metadata] = await args.db
    .select({
      rawSize: blobs.rawSize,
      encoding: blobs.encoding,
      encodedSize: blobs.encodedSize,
    })
    .from(blobs)
    .where(eq(blobs.hash, args.hash))
    .limit(1);
  if (
    metadata?.rawSize !== args.bytes.length ||
    metadata.encodedSize !== args.bytes.length ||
    metadata.encoding !== SESSION_HISTORY_ENCODING_IDENTITY
  ) {
    throw new Error("Pi API first-turn blob metadata is incompatible");
  }
  await args.get(
    putImmutableS3Object(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      resumeSessionHistoryRawBlobKey(args.hash),
      args.bytes,
      "application/octet-stream",
      signal,
    ),
  );
}

async function writeManifest(
  args: {
    readonly get: ComputedGetter;
    readonly runId: string;
    readonly manifest: PiApiFirstTurnManifest;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.get(
    putS3Object(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      piApiFirstTurnObjectKey(args.runId, "manifest"),
      JSON.stringify(args.manifest),
      "application/json",
      signal,
    ),
  );
}

interface ApiFirstTurnDependencies {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly set: Parameters<Parameters<typeof command>[0]>[0]["set"];
  readonly activation: PiApiFirstTurnActivation;
}

interface PreparedApiFirstTurn {
  readonly apiStartTime: number;
  readonly auth: SandboxAuth;
  readonly baseSession: PiApiFirstTurnManifest["baseSession"];
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

function validateApiFirstTurnLaunch(args: ApiFirstTurnDependencies): {
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

async function assertApiTurnCommittable(
  args: ApiFirstTurnDependencies,
  deadlineAt: number,
  message: string,
): Promise<void> {
  if (!(await canCommitApiTurn(args.db, args.activation.runId, deadlineAt))) {
    throw piApiFirstTurnError("PI_API_FIRST_TURN_NOT_COMMITTABLE", message);
  }
}

async function loadApiFirstTurnResource(
  args: ApiFirstTurnDependencies,
  executionContext: ApiFirstTurnExecutionContext,
  expectedDigest: string,
  signal: AbortSignal,
): Promise<PiResourceSnapshot> {
  const prepared = await settle(
    args.get(
      preparePiResourceSnapshot(
        {
          db: args.db,
          mounts: executionContext.storageMounts,
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
}

async function resolveApiFirstTurnKey(
  args: ApiFirstTurnDependencies,
  executionContext: ApiFirstTurnExecutionContext,
): Promise<string> {
  const modelConfig = executionContext.piModelConfig;
  const decrypted = await settle(
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
  let apiKey = secrets?.[modelConfig.credentialSecretName];
  const providerKey =
    executionContext.secretConnectorMap?.[modelConfig.credentialSecretName];
  const metadata =
    executionContext.secretConnectorMetadataMap?.[
      modelConfig.credentialSecretName
    ];
  if (!apiKey && providerKey && metadata) {
    const resolved = await settle(
      resolveModelProviderRuntimeSecretForApi({
        db: args.db,
        orgId: args.activation.orgId,
        userId: args.activation.userId,
        key: modelConfig.credentialSecretName,
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
    apiKey = resolved.value ?? undefined;
  }
  if (!apiKey?.trim()) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn model credential is unavailable",
    );
  }
  return apiKey;
}

async function executeApiModelTurn(
  args: {
    readonly activation: PiApiFirstTurnActivation;
    readonly apiKey: string;
    readonly executionContext: ApiFirstTurnExecutionContext;
    readonly launchConfig: ApiFirstTurnLaunchConfig;
    readonly loadedSession: LoadedResumeSession;
    readonly resourceSnapshot: PiResourceSnapshot;
    readonly sessionId: string;
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
  const executed = await settleIncludingAbort(
    runPiApiFirstTurn(
      {
        cwd: CANONICAL_WORKING_DIR,
        agentDir: PI_AGENT_DIR,
        sessionId: args.sessionId,
        sessionJsonl: args.loadedSession.jsonl,
        prompt: args.activation.prompt,
        appendSystemPrompt: args.activation.appendSystemPrompt,
        model: { ...args.executionContext.piModelConfig, apiKey: args.apiKey },
        resourceSnapshot: args.resourceSnapshot,
      },
      modelSignal,
    ),
  );
  if (!executed.ok) {
    if (executed.error instanceof UnsupportedPiResourceSnapshotError) {
      throw piApiFirstTurnError(
        "PI_API_RESOURCE_UNSUPPORTED",
        executed.error.message,
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
    );
  }
  const turn = executed.value;
  if (
    turn.assistantMessage.stopReason === "error" ||
    turn.assistantMessage.stopReason === "aborted"
  ) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_FAILED",
      `Pi API first-turn model stopped with ${turn.assistantMessage.stopReason}`,
    );
  }
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
    return MemoryPiSession.fromJsonl(turn.sessionJsonl);
  });
  if ("error" in parsed) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi API first turn produced an invalid H1 session",
      parsed.error,
    );
  }
  const committedSession = parsed.ok;
  if (committedSession.getSessionId() !== sessionId) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi H1 session id does not match the launch session",
    );
  }
  if (
    (turn.handoffRequired && !committedSession.hasPendingToolCalls()) ||
    (!turn.handoffRequired && !committedSession.isSettledCheckpoint())
  ) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi H1 state does not match the API first-turn outcome",
    );
  }
  return { sessionBytes, sessionHash: sha256(sessionBytes) };
}

async function prepareApiFirstTurn(
  args: ApiFirstTurnDependencies,
  signal: AbortSignal,
): Promise<PreparedApiFirstTurn> {
  const { executionContext, launchConfig, sessionId } =
    validateApiFirstTurnLaunch(args);
  await assertApiTurnCommittable(
    args,
    launchConfig.deadlineAt,
    "Pi API first turn is no longer eligible to commit",
  );
  const resourceSnapshot = await loadApiFirstTurnResource(
    args,
    executionContext,
    launchConfig.resourceSnapshotDigest,
    signal,
  );
  const apiKey = await resolveApiFirstTurnKey(args, executionContext);
  const loadedSession = await loadResumeSessionJsonl(
    {
      db: args.db,
      get: args.get,
      resumeSession: executionContext.resumeSession,
    },
    signal,
  );
  validateResumeSession({
    loaded: loadedSession,
    expectedBaseSession: launchConfig.baseSession,
    sessionId,
  });
  const { startedAt, turn } = await executeApiModelTurn(
    {
      activation: args.activation,
      apiKey,
      executionContext,
      launchConfig,
      loadedSession,
      resourceSnapshot,
      sessionId,
    },
    signal,
  );
  const { sessionBytes, sessionHash } = validateApiFirstTurnH1(turn, sessionId);
  await assertApiTurnCommittable(
    args,
    launchConfig.deadlineAt,
    "Pi API first turn lost commit eligibility after the model request",
  );
  const auth: SandboxAuth = {
    userId: args.activation.userId,
    orgId: args.activation.orgId,
    runId: args.activation.runId,
  };
  return {
    apiStartTime: executionContext.apiStartTime,
    auth,
    baseSession: launchConfig.baseSession,
    sessionBytes,
    sessionHash,
    sessionId,
    startedAt,
    turn,
  };
}

async function persistCompleteTurnCheckpoint(
  args: ApiFirstTurnDependencies,
  prepared: PreparedApiFirstTurn,
  signal: AbortSignal,
): Promise<void> {
  await persistIdentitySessionBlob(
    {
      db: args.db,
      get: args.get,
      hash: prepared.sessionHash,
      bytes: prepared.sessionBytes,
    },
    signal,
  );
  const checkpoint = await args.set(
    createAgentCheckpoint$,
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
}

async function finalizeCompleteTurn(
  args: ApiFirstTurnDependencies,
  prepared: PreparedApiFirstTurn,
  signal: AbortSignal,
): Promise<void> {
  const completion = await args.set(
    completeAgentRun$,
    {
      auth: prepared.auth,
      body: {
        runId: args.activation.runId,
        exitCode: 0,
        lastEventSequence: 1,
      },
    },
    signal,
  );
  if (completion.status !== 200) {
    throw new Error("Pi API first-turn completion was rejected");
  }
  if (completion.sideEffects) {
    waitUntil(
      args.set(
        dispatchCompleteSideEffects$,
        {
          ...completion.sideEffects,
          apiStartTime: prepared.apiStartTime,
        },
        signal,
      ),
    );
  }
}

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

async function commitApiFirstTurn(
  args: ApiFirstTurnDependencies,
  prepared: PreparedApiFirstTurn,
  signal: AbortSignal,
): Promise<void> {
  await args.get(
    putS3Object(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      piApiFirstTurnObjectKey(args.activation.runId, "session"),
      prepared.sessionBytes,
      "application/x-ndjson",
      signal,
    ),
  );

  const events = prepared.turn.handoffRequired
    ? [assistantEvent(args.activation.runId, prepared.turn.assistantMessage)]
    : [
        assistantEvent(args.activation.runId, prepared.turn.assistantMessage),
        resultEvent(prepared.turn.assistantMessage, prepared.startedAt),
      ];
  await publishEvents({ set: args.set, auth: prepared.auth, events }, signal);
  if (prepared.turn.handoffRequired) {
    const manifest: PiApiFirstTurnManifest = {
      schemaVersion: 1,
      outcome: "handoff",
      baseSession: prepared.baseSession,
      session: {
        sessionId: prepared.sessionId,
        sha256: prepared.sessionHash,
        rawSize: prepared.sessionBytes.length,
      },
    };
    await writeManifest(
      { get: args.get, runId: args.activation.runId, manifest },
      signal,
    );
    return;
  }

  await persistCompleteTurnCheckpoint(args, prepared, signal);
  await finalizeCompleteTurn(args, prepared, signal);
  stopPreparedSandbox(args.activation, "completed");
}

async function executeApiFirstTurn(
  args: ApiFirstTurnDependencies,
  signal: AbortSignal,
): Promise<void> {
  const prepared = await prepareApiFirstTurn(args, signal);
  const committed = await settle(
    commitApiFirstTurn(args, prepared, signal),
    signal,
  );
  if (!committed.ok) {
    if (committed.error instanceof PiApiFirstTurnError) {
      throw committed.error;
    }
    throw piApiFirstTurnError(
      "PI_API_COMMIT_FAILED",
      "Pi API first-turn H1 commit failed",
      committed.error,
    );
  }
}

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

async function failApiFirstTurn(
  args: ApiFirstTurnDependencies,
  failure: PiApiFirstTurnError,
): Promise<void> {
  const failureSignal = AbortSignal.timeout(FAILURE_COMMIT_TIMEOUT_MS);
  const completion = await args.set(
    completeAgentRun$,
    {
      auth: {
        userId: args.activation.userId,
        orgId: args.activation.orgId,
        runId: args.activation.runId,
      },
      body: {
        runId: args.activation.runId,
        exitCode: 1,
        error: failure.message,
      },
    },
    failureSignal,
  );
  failureSignal.throwIfAborted();
  if (completion.status !== 200) {
    throw new Error("Pi API first-turn failure transition was rejected");
  }
  if (completion.sideEffects) {
    waitUntil(
      args.set(
        dispatchCompleteSideEffects$,
        {
          ...completion.sideEffects,
          apiStartTime: args.activation.executionContext.apiStartTime,
        },
        failureSignal,
      ),
    );
  }
}

export const runPiApiFirstTurn$ = command(
  async (
    { get, set },
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ) => {
    const dependencies = { db: set(writeDb$), get, set, activation };
    // eslint-disable-next-line api/signal-check-await -- API-slot cancellation is captured and persisted as the run's terminal failure below
    const executed = await settleIncludingAbort(
      executeApiFirstTurn(dependencies, signal),
    );
    if (executed.ok) {
      return;
    }
    const failure = normalizedApiFirstTurnFailure(executed.error, signal);
    L.warn("Pi API first-turn failed", {
      runId: activation.runId,
      code: failure.code,
      error: failure,
    });
    // eslint-disable-next-line api/signal-check-await -- failure commit uses its own bounded signal and must finish after the API-slot signal expires
    await failApiFirstTurn(dependencies, failure);
    stopPreparedSandbox(activation, "failed");
  },
);
