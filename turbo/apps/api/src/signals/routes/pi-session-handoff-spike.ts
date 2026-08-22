import { createHash, randomUUID } from "node:crypto";

import { MemoryPiSession } from "@okouai/pi-agent-runtime";
import { resumePendingPiToolCalls } from "@okouai/pi-agent-runtime/node";
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
  putS3Object,
  s3ObjectHead,
} from "../external/s3";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const c = initContract();
const historyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const handoffIdSchema = z.uuid();
const handoffManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.uuid(),
  historyHash: historyHashSchema,
});

const publishResponseSchema = z.object({
  ok: z.literal(true),
  handoff_id: handoffIdSchema,
  session_id: z.uuid(),
  canonical_history_hash: historyHashSchema,
  handoff_history_hash: historyHashSchema,
  history_bytes: z.int().positive(),
  r2_write_ms: z.number().nonnegative(),
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
  source_history_hash: historyHashSchema,
  downloaded_history_hash: historyHashSchema,
  final_history_hash: historyHashSchema,
  final_downloaded_history_hash: historyHashSchema,
  source_history_bytes: z.int().positive(),
  final_history_bytes: z.int().positive(),
  tool_results: z.int().positive(),
  r2_read_ms: z.number().nonnegative(),
  r2_checkpoint_ms: z.number().nonnegative(),
  cleanup_completed: z.literal(true),
});

export const piSessionHandoffSpikeContract = c.router({
  publish: {
    method: "POST",
    path: "/api/test/pi-session-handoff-spike",
    body: z.object({}),
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
    body: z.object({}),
    responses: {
      200: resumeResponseSchema,
      400: z.object({ error: z.unknown() }),
      404: z.string(),
    },
    summary: "Resume and complete a Pi session from an R2 handoff",
  },
});

const publishBody$ = bodyResultOf(piSessionHandoffSpikeContract.publish);
const statusParams$ = pathParamsOf(piSessionHandoffSpikeContract.status);
const statusQuery$ = queryOf(piSessionHandoffSpikeContract.status);
const resumeParams$ = pathParamsOf(piSessionHandoffSpikeContract.resume);
const resumeBody$ = bodyResultOf(piSessionHandoffSpikeContract.resume);

const HANDOFF_PREFIX = "spikes/pi-session-handoffs";
const SPIKE_CWD = "/home/user/workspace";
const SPIKE_TOOL_CALL_ID = "api-first-turn-tool-call";
const SPIKE_TOOL_PATH = "/home/user/.pi/agent/skills/example/SKILL.md";

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

function apiHandoffSession(sessionId: string): {
  readonly canonicalJsonl: string;
  readonly handoffJsonl: string;
} {
  const session = MemoryPiSession.create({ cwd: SPIKE_CWD, id: sessionId });
  session.appendMessage({
    role: "user",
    content: "historical question",
    timestamp: 1,
  });
  appendAssistantText(session, "historical answer", 2);
  const canonicalJsonl = session.toJsonl();
  session.appendMessage({
    role: "user",
    content: "read the example skill",
    timestamp: 3,
  });
  session.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: SPIKE_TOOL_CALL_ID,
        name: "read",
        arguments: { path: SPIKE_TOOL_PATH },
      },
    ],
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
    timestamp: 4,
  });
  return { canonicalJsonl, handoffJsonl: session.toJsonl() };
}

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

    const handoffId = randomUUID();
    const sessionId = randomUUID();
    const { canonicalJsonl, handoffJsonl } = apiHandoffSession(sessionId);
    const canonicalHistoryHash = sha256(canonicalJsonl);
    const historyHash = sha256(handoffJsonl);
    const manifest = handoffManifestSchema.parse({
      schemaVersion: 1,
      sessionId,
      historyHash,
    });
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
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
        session_id: sessionId,
        canonical_history_hash: canonicalHistoryHash,
        handoff_history_hash: historyHash,
        history_bytes: Buffer.byteLength(handoffJsonl),
        r2_write_ms: performance.now() - writeStartedAt,
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
    const sourceKey = handoffHistoryKey(handoffId, manifest.historyHash);
    const sourceBuffer = await get(downloadS3Buffer(bucket, sourceKey));
    signal.throwIfAborted();
    const downloadedHistoryHash = sha256(sourceBuffer);
    if (downloadedHistoryHash !== manifest.historyHash) {
      throw new Error("Pi handoff history hash mismatch");
    }
    const r2ReadMs = performance.now() - readStartedAt;

    const session = MemoryPiSession.fromJsonl(sourceBuffer.toString("utf8"));
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
    appendAssistantText(session, "sandbox continuation complete", 5);
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

    await get(deleteS3Objects(bucket, [manifestKey, sourceKey, finalKey]));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        handoff_id: handoffId,
        session_id: manifest.sessionId,
        source_history_hash: manifest.historyHash,
        downloaded_history_hash: downloadedHistoryHash,
        final_history_hash: finalHistoryHash,
        final_downloaded_history_hash: finalDownloadedHistoryHash,
        source_history_bytes: sourceBuffer.byteLength,
        final_history_bytes: finalBuffer.byteLength,
        tool_results: toolResults.length,
        r2_read_ms: r2ReadMs,
        r2_checkpoint_ms: r2CheckpointMs,
        cleanup_completed: true as const,
      },
    };
  },
);

export const piSessionHandoffSpikeRoutes: readonly RouteEntry[] = [
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
];
