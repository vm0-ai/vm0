import { createHash } from "node:crypto";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  type PiApiFirstTurnManifest,
  type PiApiFirstTurnOwnershipTransferMode,
  type PiResourceSnapshot,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { activeInputDeliveries } from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import {
  inspectPiSessionJsonl,
  runPiApiFirstTurn,
  type PiApiFirstTurnResult,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
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
  type CompleteSideEffectsInput,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { createPiApiFirstTurnCheckpoint$ } from "./agent-webhook-checkpoints.service";
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
  readonly sessionBytes: Buffer;
  readonly sessionHash: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly turn: PiApiFirstTurnResult;
  readonly ownershipTransferCapability: ApiFirstTurnLaunchConfig["ownershipTransfer"];
}

type ApiFirstTurnExecutionContext =
  PiApiFirstTurnActivation["executionContext"];
type ApiFirstTurnLaunchConfig =
  ApiFirstTurnExecutionContext["piLaunchConfig"]["apiFirstTurn"];

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

async function assertApiTurnCommittable(
  args: ApiFirstTurnContext,
  deadlineAt: number,
  message: string,
): Promise<void> {
  if (!(await canCommitApiTurn(args.db, args.activation.runId, deadlineAt))) {
    throw piApiFirstTurnError("PI_API_FIRST_TURN_NOT_COMMITTABLE", message);
  }
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
  },
);

async function resolveApiFirstTurnKey(
  args: ApiFirstTurnContext,
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
  readonly capability: ApiFirstTurnLaunchConfig["ownershipTransfer"];
  readonly mode: PiApiFirstTurnOwnershipTransferMode;
  readonly baseSession: PiApiFirstTurnManifest["baseSession"];
  readonly session: {
    readonly sessionId: string;
    readonly sha256: string;
    readonly rawSize: number;
  };
  readonly sandboxEventSequenceStart: number;
}): PiApiFirstTurnManifest {
  if (args.capability?.schemaVersion === 1) {
    return {
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: args.mode,
      baseSession: args.baseSession,
      session: args.session,
      sandboxEventSequenceStart: args.sandboxEventSequenceStart,
    };
  }
  if (args.mode !== "pending-tool-continuation") {
    throw piApiFirstTurnError(
      "PI_LAUNCH_CONFIG_INVALID",
      "Pi ownership transfer is not supported by the selected Sandbox",
    );
  }
  return {
    schemaVersion: 2,
    outcome: "handoff",
    baseSession: args.baseSession,
    session: args.session,
    sandboxEventSequenceStart: args.sandboxEventSequenceStart,
  };
}

const prepareApiFirstTurn$ = command(async function prepareApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  signal: AbortSignal,
): Promise<PreparedApiFirstTurn> {
  const { executionContext, launchConfig, sessionId } =
    validateApiFirstTurnLaunch(args);
  await assertApiTurnCommittable(
    args,
    launchConfig.deadlineAt,
    "Pi API first turn is no longer eligible to commit",
  );
  signal.throwIfAborted();
  const resourceSnapshot = await set(
    loadApiFirstTurnResource$,
    args,
    executionContext,
    launchConfig.resourceSnapshotDigest,
    signal,
  );
  signal.throwIfAborted();
  const apiKey = await resolveApiFirstTurnKey(args, executionContext);
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
  signal.throwIfAborted();
  const { sessionBytes, sessionHash } = validateApiFirstTurnH1(turn, sessionId);
  await assertApiTurnCommittable(
    args,
    launchConfig.deadlineAt,
    "Pi API first turn lost commit eligibility after the model request",
  );
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
    sessionBytes,
    sessionHash,
    sessionId,
    startedAt,
    turn,
    ownershipTransferCapability: launchConfig.ownershipTransfer,
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
  const events = prepared.turn.handoffRequired
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
  if (prepared.turn.handoffRequired) {
    const manifest = ownershipTransferManifest({
      capability: prepared.ownershipTransferCapability,
      mode: "pending-tool-continuation",
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
  return sideEffects;
});

const executeApiFirstTurn$ = command(async function executeApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  signal: AbortSignal,
): Promise<CompleteSideEffectsInput | undefined> {
  const prepared = await set(prepareApiFirstTurn$, args, signal);
  const committed = await settle(
    set(commitApiFirstTurn$, args, prepared, signal),
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

const failApiFirstTurn$ = command(async function failApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  failure: PiApiFirstTurnError,
): Promise<DispatchCompleteSideEffectsInput | undefined> {
  const failureSignal = AbortSignal.timeout(FAILURE_COMMIT_TIMEOUT_MS);
  const completion = await set(
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
  stopPreparedSandbox(args.activation, "failed");
  return completion.sideEffects
    ? {
        ...completion.sideEffects,
        apiStartTime: args.activation.executionContext.apiStartTime,
      }
    : undefined;
});

export const runPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ): Promise<DispatchCompleteSideEffectsInput | undefined> => {
    const context: ApiFirstTurnContext = { db: set(writeDb$), activation };
    const executed = await settleApiFirstTurnExecution(
      set(executeApiFirstTurn$, context, signal),
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
    const failure = normalizedApiFirstTurnFailure(executed.error, signal);
    L.warn("Pi API first-turn failed", {
      runId: activation.runId,
      code: failure.code,
      error: failure,
    });
    return set(failApiFirstTurn$, context, failure);
  },
);
