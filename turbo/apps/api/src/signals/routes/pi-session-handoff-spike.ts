import { createHash } from "node:crypto";

import { MemoryPiSession } from "@okouai/pi-agent-runtime";
import { resumePendingPiToolCalls } from "@okouai/pi-agent-runtime/node";
import {
  RESUME_SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
  sessionHistoryEncodingSchema,
} from "@okouai/api-contracts/contracts/runners";
import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import {
  deleteS3Objects,
  downloadS3Buffer,
  downloadS3BufferWithMaxBytes,
  generatePresignedPutUrl,
  putS3Object,
  s3ObjectHead,
} from "../external/s3";
import type { RouteEntry } from "../route-entry";
import {
  gunzipSessionHistoryBufferWithMaxBytes,
  unzstdSessionHistoryBufferWithMaxBytes,
} from "../services/session-history-decompression";
import { safeJsonParse } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const c = initContract();
const historyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const handoffIdSchema = z.uuid();
const sourceReferenceSchema = z.object({
  session_id: z.uuid(),
  history_hash: historyHashSchema,
  encoding: sessionHistoryEncodingSchema,
  raw_size: z.int().positive().max(RESUME_SESSION_HISTORY_MAX_BYTES),
  encoded_size: z.int().positive().max(RESUME_SESSION_HISTORY_MAX_BYTES),
});
const handoffManifestSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.uuid(),
  baseHistoryHash: historyHashSchema,
  baseHistoryEncoding: sessionHistoryEncodingSchema,
  handoffHistoryHash: historyHashSchema,
  handoffHistoryBytes: z.int().positive(),
  promptHash: historyHashSchema,
  toolCallCount: z.int().positive(),
});

const sourcePrepareResponseSchema = z.object({
  ok: z.literal(true),
  upload_url: z.url(),
  source_key: z.string().min(1),
  content_type: z.literal("application/octet-stream"),
});

const publishResponseSchema = z.object({
  ok: z.literal(true),
  handoff_id: handoffIdSchema,
  session_id: z.uuid(),
  base_history_hash: historyHashSchema,
  handoff_history_hash: historyHashSchema,
  base_history_encoding: sessionHistoryEncodingSchema,
  base_history_bytes: z.int().positive(),
  base_encoded_bytes: z.int().positive(),
  handoff_history_bytes: z.int().positive(),
  base_message_count: z.int().nonnegative(),
  handoff_message_count: z.int().positive(),
  prompt_occurrences: z.int().nonnegative(),
  tool_calls: z.int().positive(),
  r2_source_read_ms: z.number().nonnegative(),
  history_parse_ms: z.number().nonnegative(),
  r2_write_ms: z.number().nonnegative(),
  pointer_published_after_history: z.literal(true),
  filesystem_materialized: z.literal(false),
});

const handoffStateSchema = z.enum(["waiting", "resume", "timeout"]);
const statusResponseSchema = z.object({
  ok: z.literal(true),
  state: handoffStateSchema,
  handoff_pointer_present: z.boolean(),
});

const resumeResponseSchema = z.object({
  ok: z.literal(true),
  handoff_id: handoffIdSchema,
  session_id: z.uuid(),
  base_history_hash: historyHashSchema,
  handoff_history_hash: historyHashSchema,
  downloaded_handoff_history_hash: historyHashSchema,
  final_history_hash: historyHashSchema,
  final_downloaded_history_hash: historyHashSchema,
  final_history_key: z.string().min(1),
  handoff_history_bytes: z.int().positive(),
  final_history_bytes: z.int().positive(),
  tool_results: z.int().positive(),
  prompt_occurrences: z.int().nonnegative(),
  r2_read_ms: z.number().nonnegative(),
  r2_checkpoint_ms: z.number().nonnegative(),
  base_history_preserved: z.literal(true),
  final_history_preserved: z.literal(true),
  cleanup_completed: z.literal(true),
});

const artifactCleanupResponseSchema = z.object({
  ok: z.literal(true),
  cleanup_completed: z.literal(true),
});

export const piSessionHandoffSpikeContract = c.router({
  prepareSource: {
    method: "POST",
    path: "/api/test/pi-session-handoff-spike/source/prepare",
    body: sourceReferenceSchema,
    responses: {
      200: sourcePrepareResponseSchema,
      400: z.object({ error: z.unknown() }),
      404: z.string(),
    },
    summary: "Prepare a direct R2 upload for a canonical Pi session",
  },
  publish: {
    method: "POST",
    path: "/api/test/pi-session-handoff-spike",
    body: z.object({
      handoff_id: handoffIdSchema,
      source: sourceReferenceSchema,
      prompt: z
        .string()
        .min(1)
        .max(1024 * 1024),
    }),
    responses: {
      200: publishResponseSchema,
      400: z.object({ error: z.unknown() }),
      404: z.string(),
    },
    summary: "Publish a one-shot Pi session handoff through R2",
  },
  status: {
    method: "GET",
    path: "/api/test/pi-session-handoff-spike/:handoffId",
    pathParams: z.object({ handoffId: handoffIdSchema }),
    query: z.object({
      deadline_ms: z.coerce.number().int().nonnegative(),
    }),
    responses: {
      200: statusResponseSchema,
      404: z.string(),
    },
    summary: "Resolve a Pi handoff from one pointer and one deadline",
  },
  resume: {
    method: "POST",
    path: "/api/test/pi-session-handoff-spike/:handoffId/resume",
    pathParams: z.object({ handoffId: handoffIdSchema }),
    body: z.object({
      session_id: z.uuid(),
      base_history_hash: historyHashSchema,
    }),
    responses: {
      200: resumeResponseSchema,
      400: z.object({ error: z.unknown() }),
      409: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Resume and complete a Pi session from an R2 handoff",
  },
  cleanupArtifacts: {
    method: "POST",
    path: "/api/test/pi-session-handoff-spike/:handoffId/artifacts/cleanup",
    pathParams: z.object({ handoffId: handoffIdSchema }),
    body: z.object({
      base_history_hash: historyHashSchema,
      base_history_encoding: sessionHistoryEncodingSchema,
      final_history_hash: historyHashSchema,
    }),
    responses: {
      200: artifactCleanupResponseSchema,
      400: z.object({ error: z.unknown() }),
      404: z.string(),
    },
    summary: "Clean up canonical artifacts created by the handoff spike",
  },
});

const prepareSourceBody$ = bodyResultOf(
  piSessionHandoffSpikeContract.prepareSource,
);
const publishBody$ = bodyResultOf(piSessionHandoffSpikeContract.publish);
const statusParams$ = pathParamsOf(piSessionHandoffSpikeContract.status);
const statusQuery$ = queryOf(piSessionHandoffSpikeContract.status);
const resumeParams$ = pathParamsOf(piSessionHandoffSpikeContract.resume);
const resumeBody$ = bodyResultOf(piSessionHandoffSpikeContract.resume);
const cleanupArtifactsParams$ = pathParamsOf(
  piSessionHandoffSpikeContract.cleanupArtifacts,
);
const cleanupArtifactsBody$ = bodyResultOf(
  piSessionHandoffSpikeContract.cleanupArtifacts,
);

const HANDOFF_PREFIX = "spikes/pi-session-handoffs";
const SOURCE_UPLOAD_TTL_SECONDS = 60 * 60;
const SPIKE_TOOL_CALLS = [
  {
    id: "api-first-turn-tool-call-skill",
    path: "/home/user/.pi/agent/skills/example/SKILL.md",
  },
  {
    id: "api-first-turn-tool-call-agent",
    path: "/home/user/.pi/agent/agents/example.md",
  },
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function handoffPrefix(handoffId: string): string {
  return `${HANDOFF_PREFIX}/${handoffId}`;
}

function handoffManifestKey(handoffId: string): string {
  return `${handoffPrefix(handoffId)}/handoff.json`;
}

function handoffHistoryKey(handoffId: string, historyHash: string): string {
  return `${handoffPrefix(handoffId)}/blobs/${historyHash}.blob`;
}

function sourceHistoryKey(
  historyHash: string,
  encoding: z.infer<typeof sessionHistoryEncodingSchema>,
): string {
  const suffix =
    encoding === SESSION_HISTORY_ENCODING_GZIP
      ? ".jsonl.gz"
      : encoding === SESSION_HISTORY_ENCODING_ZSTD
        ? ".jsonl.zst"
        : ".jsonl";
  return `${HANDOFF_PREFIX}/sources/${historyHash}${suffix}`;
}

async function decodeSourceHistory(args: {
  readonly buffer: Buffer;
  readonly encoding: z.infer<typeof sessionHistoryEncodingSchema>;
  readonly key: string;
  readonly maxRawBytes: number;
}): Promise<Buffer> {
  switch (args.encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return await gunzipSessionHistoryBufferWithMaxBytes(
        args.key,
        args.buffer,
        args.maxRawBytes,
      );
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return await unzstdSessionHistoryBufferWithMaxBytes(
        args.key,
        args.buffer,
        args.maxRawBytes,
      );
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return args.buffer;
    }
  }
}

function appendAssistantText(
  session: MemoryPiSession,
  text: string,
  timestamp: number,
): void {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp,
  });
}

function appendApiFirstTurn(
  session: MemoryPiSession,
  prompt: string,
  timestamp: number,
): void {
  session.appendMessage({
    role: "user",
    content: prompt,
    timestamp,
  });
  session.appendMessage({
    role: "assistant",
    content: SPIKE_TOOL_CALLS.map((toolCall) => {
      return {
        type: "toolCall" as const,
        id: toolCall.id,
        name: "read",
        arguments: { path: toolCall.path },
      };
    }),
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: timestamp + 1,
  });
}

function countPromptOccurrences(
  session: MemoryPiSession,
  expectedPromptHash: string,
): number {
  return session.buildSessionContext().messages.filter((message) => {
    return (
      message.role === "user" &&
      typeof message.content === "string" &&
      sha256(message.content) === expectedPromptHash
    );
  }).length;
}

const preparePiSessionHandoffSource$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(prepareSourceBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const source = bodyResult.data;
    const key = sourceHistoryKey(source.history_hash, source.encoding);
    const uploadUrl = await get(
      generatePresignedPutUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        key,
        "application/octet-stream",
        SOURCE_UPLOAD_TTL_SECONDS,
        true,
      ),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        upload_url: uploadUrl,
        source_key: key,
        content_type: "application/octet-stream" as const,
      },
    };
  },
);

const publishPiSessionHandoffSpike$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(publishBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { handoff_id: handoffId, prompt, source } = bodyResult.data;
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const sourceKey = sourceHistoryKey(source.history_hash, source.encoding);
    const sourceReadStartedAt = performance.now();
    const encodedSource = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        sourceKey,
        source.encoded_size,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (encodedSource.byteLength !== source.encoded_size) {
      return {
        status: 400 as const,
        body: { error: "Pi source history encoded size mismatch" },
      };
    }
    const sourceBuffer = await decodeSourceHistory({
      buffer: encodedSource,
      encoding: source.encoding,
      key: sourceKey,
      maxRawBytes: source.raw_size,
    });
    signal.throwIfAborted();
    if (sourceBuffer.byteLength !== source.raw_size) {
      return {
        status: 400 as const,
        body: { error: "Pi source history raw size mismatch" },
      };
    }
    if (sha256(sourceBuffer) !== source.history_hash) {
      return {
        status: 400 as const,
        body: { error: "Pi source history hash mismatch" },
      };
    }
    const r2SourceReadMs = performance.now() - sourceReadStartedAt;

    const parseStartedAt = performance.now();
    const session = MemoryPiSession.fromJsonl(sourceBuffer.toString("utf8"));
    if (session.getSessionId() !== source.session_id) {
      return {
        status: 400 as const,
        body: { error: "Pi source history session ID mismatch" },
      };
    }
    const baseMessageCount = session.buildSessionContext().messages.length;
    appendApiFirstTurn(session, prompt, now());
    const handoffJsonl = session.toJsonl();
    const handoffMessageCount = session.buildSessionContext().messages.length;
    const promptHash = sha256(prompt);
    const promptOccurrences = countPromptOccurrences(session, promptHash);
    const historyParseMs = performance.now() - parseStartedAt;
    const historyHash = sha256(handoffJsonl);
    const handoffHistoryBytes = Buffer.byteLength(handoffJsonl);
    const manifest = handoffManifestSchema.parse({
      schemaVersion: 2,
      sessionId: source.session_id,
      baseHistoryHash: source.history_hash,
      baseHistoryEncoding: source.encoding,
      handoffHistoryHash: historyHash,
      handoffHistoryBytes,
      promptHash,
      toolCallCount: SPIKE_TOOL_CALLS.length,
    });
    const writeStartedAt = performance.now();
    await get(
      putS3Object(
        bucket,
        handoffHistoryKey(handoffId, historyHash),
        handoffJsonl,
        "application/x-ndjson",
        signal,
      ),
    );
    signal.throwIfAborted();
    await get(
      putS3Object(
        bucket,
        handoffManifestKey(handoffId),
        JSON.stringify(manifest),
        "application/json",
        signal,
      ),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        handoff_id: handoffId,
        session_id: source.session_id,
        base_history_hash: source.history_hash,
        handoff_history_hash: historyHash,
        base_history_encoding: source.encoding,
        base_history_bytes: sourceBuffer.byteLength,
        base_encoded_bytes: encodedSource.byteLength,
        handoff_history_bytes: handoffHistoryBytes,
        base_message_count: baseMessageCount,
        handoff_message_count: handoffMessageCount,
        prompt_occurrences: promptOccurrences,
        tool_calls: SPIKE_TOOL_CALLS.length,
        r2_source_read_ms: r2SourceReadMs,
        history_parse_ms: historyParseMs,
        r2_write_ms: performance.now() - writeStartedAt,
        pointer_published_after_history: true as const,
        filesystem_materialized: false as const,
      },
    };
  },
);

const readPiSessionHandoffSpikeStatus$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const { handoffId } = get(statusParams$);
    const { deadline_ms: deadlineMs } = get(statusQuery$);
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const head = await get(s3ObjectHead(bucket, handoffManifestKey(handoffId)));
    signal.throwIfAborted();
    const pointerPresent = head.kind === "found";

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        state:
          now() >= deadlineMs
            ? ("timeout" as const)
            : pointerPresent
              ? ("resume" as const)
              : ("waiting" as const),
        handoff_pointer_present: pointerPresent,
      },
    };
  },
);

const resumePiSessionHandoffSpike$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const { handoffId } = get(resumeParams$);
    const bodyResult = await get(resumeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifestKey = handoffManifestKey(handoffId);
    const manifestHead = await get(s3ObjectHead(bucket, manifestKey));
    signal.throwIfAborted();
    if (manifestHead.kind === "missing") {
      return { status: 404 as const, body: "Not found" };
    }

    const readStartedAt = performance.now();
    const manifestBuffer = await get(downloadS3Buffer(bucket, manifestKey));
    signal.throwIfAborted();
    const manifest = handoffManifestSchema.parse(
      safeJsonParse(manifestBuffer.toString("utf8")),
    );
    if (
      bodyResult.data.session_id !== manifest.sessionId ||
      bodyResult.data.base_history_hash !== manifest.baseHistoryHash
    ) {
      return {
        status: 409 as const,
        body: { error: "Pi handoff base session does not match sandbox H0" },
      };
    }
    const sourceKey = handoffHistoryKey(handoffId, manifest.handoffHistoryHash);
    const sourceBuffer = await get(downloadS3Buffer(bucket, sourceKey));
    signal.throwIfAborted();
    const downloadedHistoryHash = sha256(sourceBuffer);
    if (
      sourceBuffer.byteLength !== manifest.handoffHistoryBytes ||
      downloadedHistoryHash !== manifest.handoffHistoryHash
    ) {
      throw new Error("Pi handoff history hash mismatch");
    }
    const r2ReadMs = performance.now() - readStartedAt;

    const session = MemoryPiSession.fromJsonl(sourceBuffer.toString("utf8"));
    if (session.getSessionId() !== manifest.sessionId) {
      throw new Error("Pi handoff session ID mismatch");
    }
    const promptOccurrences = countPromptOccurrences(
      session,
      manifest.promptHash,
    );
    if (promptOccurrences !== 1) {
      throw new Error("Pi handoff prompt was not preserved exactly once");
    }
    const toolResults = await resumePendingPiToolCalls(
      {
        session,
        tools: [
          {
            name: "read",
            execute(args: Record<string, unknown>) {
              return Promise.resolve({
                content: [
                  {
                    type: "text" as const,
                    text: `skill body for ${String(args.path)}`,
                  },
                ],
              });
            },
          },
        ],
      },
      signal,
    );
    if (toolResults.length !== manifest.toolCallCount) {
      throw new Error("Pi handoff pending tool count mismatch");
    }
    appendAssistantText(session, "sandbox continuation complete", now());
    const finalJsonl = session.toJsonl();
    const finalHistoryHash = sha256(finalJsonl);
    const finalKey = handoffHistoryKey(handoffId, finalHistoryHash);

    const checkpointStartedAt = performance.now();
    await get(
      putS3Object(bucket, finalKey, finalJsonl, "application/x-ndjson", signal),
    );
    signal.throwIfAborted();
    const finalBuffer = await get(downloadS3Buffer(bucket, finalKey));
    signal.throwIfAborted();
    const finalDownloadedHistoryHash = sha256(finalBuffer);
    if (finalDownloadedHistoryHash !== finalHistoryHash) {
      throw new Error("Pi final checkpoint history hash mismatch");
    }
    const r2CheckpointMs = performance.now() - checkpointStartedAt;

    await get(deleteS3Objects(bucket, [manifestKey, sourceKey]));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        handoff_id: handoffId,
        session_id: manifest.sessionId,
        base_history_hash: manifest.baseHistoryHash,
        handoff_history_hash: manifest.handoffHistoryHash,
        downloaded_handoff_history_hash: downloadedHistoryHash,
        final_history_hash: finalHistoryHash,
        final_downloaded_history_hash: finalDownloadedHistoryHash,
        final_history_key: finalKey,
        handoff_history_bytes: sourceBuffer.byteLength,
        final_history_bytes: finalBuffer.byteLength,
        tool_results: toolResults.length,
        prompt_occurrences: promptOccurrences,
        r2_read_ms: r2ReadMs,
        r2_checkpoint_ms: r2CheckpointMs,
        base_history_preserved: true as const,
        final_history_preserved: true as const,
        cleanup_completed: true as const,
      },
    };
  },
);

const cleanupPiSessionHandoffArtifacts$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const { handoffId } = get(cleanupArtifactsParams$);
    const bodyResult = await get(cleanupArtifactsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    await get(
      deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), [
        sourceHistoryKey(body.base_history_hash, body.base_history_encoding),
        handoffHistoryKey(handoffId, body.final_history_hash),
      ]),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        cleanup_completed: true as const,
      },
    };
  },
);

export const piSessionHandoffSpikeRoutes: readonly RouteEntry[] = [
  {
    route: piSessionHandoffSpikeContract.prepareSource,
    handler: preparePiSessionHandoffSource$,
  },
  {
    route: piSessionHandoffSpikeContract.publish,
    handler: publishPiSessionHandoffSpike$,
  },
  {
    route: piSessionHandoffSpikeContract.status,
    handler: readPiSessionHandoffSpikeStatus$,
  },
  {
    route: piSessionHandoffSpikeContract.resume,
    handler: resumePiSessionHandoffSpike$,
  },
  {
    route: piSessionHandoffSpikeContract.cleanupArtifacts,
    handler: cleanupPiSessionHandoffArtifacts$,
  },
];
