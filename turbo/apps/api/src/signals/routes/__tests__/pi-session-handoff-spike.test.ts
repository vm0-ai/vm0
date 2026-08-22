import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { MemoryPiSession } from "@okouai/pi-agent-runtime";
import {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "@okouai/api-contracts/contracts/runners";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  piSessionHandoffSpikeContract,
  piSessionHandoffSpikeRoutes,
} from "../pi-session-handoff-spike";

const context = testContext();
const BUCKET = "pi-session-handoff-spike-test";
const FUTURE_DEADLINE_MS = 8_000_000_000_000_000;
const ENCODINGS = [
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_ZSTD,
] as const;
type Encoding = (typeof ENCODINGS)[number];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonl(sessionId: string): string {
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: sessionId,
  });
  session.appendMessage({
    role: "user",
    content: "historical question",
    timestamp: 1,
  });
  return session.toJsonl();
}

function encodeHistory(jsonl: string, encoding: Encoding): Buffer {
  const source = Buffer.from(jsonl);
  switch (encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return gzipSync(source);
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return zstdCompressSync(source);
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return source;
    }
  }
}

function requiredKey(key: string | undefined): string {
  if (!key) {
    throw new Error("Expected an S3 object key");
  }
  return key;
}

function objectBody(body: unknown): Buffer {
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  throw new Error("Expected a string or Buffer S3 body");
}

async function* bodyStream(body: Buffer): AsyncGenerator<Buffer> {
  yield body;
}

function missingObject(): Error {
  const error = new Error("Not found");
  error.name = "NotFound";
  return error;
}

function apiClient() {
  return setupApp({ context, routes: piSessionHandoffSpikeRoutes })(
    piSessionHandoffSpikeContract,
  );
}

function recordedPutObjectKeys(): string[] {
  return context.mocks.s3.send.mock.calls.flatMap(([command]) => {
    return command instanceof PutObjectCommand
      ? [requiredKey(command.input.Key)]
      : [];
  });
}

async function prepareSource(args: {
  readonly encoding: Encoding;
  readonly jsonl: string;
  readonly sessionId: string;
}) {
  const raw = Buffer.from(args.jsonl);
  const encoded = encodeHistory(args.jsonl, args.encoding);
  const source = {
    session_id: args.sessionId,
    history_hash: sha256(raw),
    encoding: args.encoding,
    raw_size: raw.byteLength,
    encoded_size: encoded.byteLength,
  };
  const prepared = await accept(
    apiClient().prepareSource({ body: source }),
    [200],
  );
  context.sessionHistoryBlobs.set(prepared.body.source_key, encoded);
  return { encoded, prepared, source };
}

beforeEach(() => {
  mockEnv("ENV", "development");
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      context.sessionHistoryBlobs.set(
        requiredKey(command.input.Key),
        objectBody(command.input.Body),
      );
      return Promise.resolve({});
    }
    if (command instanceof HeadObjectCommand) {
      const body = context.sessionHistoryBlobs.get(
        requiredKey(command.input.Key),
      );
      return body
        ? Promise.resolve({ ContentLength: body.byteLength })
        : Promise.reject(missingObject());
    }
    if (command instanceof GetObjectCommand) {
      const stored = context.sessionHistoryBlobs.get(
        requiredKey(command.input.Key),
      );
      const body = stored ? Buffer.from(stored) : undefined;
      return body
        ? Promise.resolve({
            Body: bodyStream(body),
            ContentLength: body.byteLength,
          })
        : Promise.reject(missingObject());
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        context.sessionHistoryBlobs.delete(requiredKey(object.Key));
      }
      return Promise.resolve({});
    }
    throw new Error("Unexpected S3 command");
  });
});

describe("Pi session handoff spike", () => {
  it("derives waiting and timeout from one absent pointer and one deadline", async () => {
    const handoffId = randomUUID();

    const waiting = await accept(
      apiClient().status({
        params: { handoffId },
        query: { deadline_ms: FUTURE_DEADLINE_MS },
      }),
      [200],
    );
    expect(waiting.body).toStrictEqual({
      ok: true,
      state: "waiting",
      handoff_pointer_present: false,
    });

    const timedOut = await accept(
      apiClient().status({
        params: { handoffId },
        query: { deadline_ms: 0 },
      }),
      [200],
    );
    expect(timedOut.body).toStrictEqual({
      ok: true,
      state: "timeout",
      handoff_pointer_present: false,
    });
  });

  it("loads H0 in every checkpoint encoding and resumes one guarded handoff", async () => {
    for (const encoding of ENCODINGS) {
      const sessionId = randomUUID();
      const handoffId = randomUUID();
      const prompt = `continue ${encoding} session exactly once`;
      const sourceUpload = await prepareSource({
        encoding,
        jsonl: canonicalJsonl(sessionId),
        sessionId,
      });

      const waiting = await accept(
        apiClient().status({
          params: { handoffId },
          query: { deadline_ms: FUTURE_DEADLINE_MS },
        }),
        [200],
      );
      expect(waiting.body).toStrictEqual({
        ok: true,
        state: "waiting",
        handoff_pointer_present: false,
      });

      const writesBeforePublish = recordedPutObjectKeys().length;
      const published = await accept(
        apiClient().publish({
          body: {
            handoff_id: handoffId,
            source: sourceUpload.source,
            prompt,
          },
        }),
        [200],
      );
      expect(published.body).toMatchObject({
        handoff_id: handoffId,
        session_id: sessionId,
        base_history_hash: sourceUpload.source.history_hash,
        base_history_encoding: encoding,
        base_history_bytes: sourceUpload.source.raw_size,
        base_encoded_bytes: sourceUpload.source.encoded_size,
        base_message_count: 1,
        handoff_message_count: 3,
        prompt_occurrences: 1,
        tool_calls: 2,
        pointer_published_after_history: true,
        filesystem_materialized: false,
      });
      expect(published.body.handoff_history_hash).not.toBe(
        published.body.base_history_hash,
      );
      expect(
        recordedPutObjectKeys().slice(
          writesBeforePublish,
          writesBeforePublish + 2,
        ),
      ).toStrictEqual([
        expect.stringContaining(
          `/blobs/${published.body.handoff_history_hash}.blob`,
        ),
        expect.stringMatching(/\/handoff\.json$/),
      ]);
      expect(
        context.sessionHistoryBlobs.get(sourceUpload.prepared.body.source_key),
      ).toStrictEqual(sourceUpload.encoded);

      const ready = await accept(
        apiClient().status({
          params: { handoffId },
          query: { deadline_ms: FUTURE_DEADLINE_MS },
        }),
        [200],
      );
      expect(ready.body).toStrictEqual({
        ok: true,
        state: "resume",
        handoff_pointer_present: true,
      });

      const expired = await accept(
        apiClient().status({
          params: { handoffId },
          query: { deadline_ms: 0 },
        }),
        [200],
      );
      expect(expired.body).toStrictEqual({
        ok: true,
        state: "timeout",
        handoff_pointer_present: true,
      });

      const mismatched = await accept(
        apiClient().resume({
          params: { handoffId },
          body: {
            session_id: randomUUID(),
            base_history_hash: published.body.base_history_hash,
          },
        }),
        [409],
      );
      expect(mismatched.body.error).toContain("does not match sandbox H0");

      const resumed = await accept(
        apiClient().resume({
          params: { handoffId },
          body: {
            session_id: sessionId,
            base_history_hash: published.body.base_history_hash,
          },
        }),
        [200],
      );
      expect(resumed.body).toMatchObject({
        session_id: sessionId,
        base_history_hash: published.body.base_history_hash,
        handoff_history_hash: published.body.handoff_history_hash,
        downloaded_handoff_history_hash: published.body.handoff_history_hash,
        tool_results: 2,
        prompt_occurrences: 1,
        base_history_preserved: true,
        final_history_preserved: true,
        cleanup_completed: true,
      });
      expect(resumed.body.final_downloaded_history_hash).toBe(
        resumed.body.final_history_hash,
      );
      expect(resumed.body.final_history_hash).not.toBe(
        resumed.body.handoff_history_hash,
      );
      expect(resumed.body.final_history_bytes).toBeGreaterThan(
        resumed.body.handoff_history_bytes,
      );
      expect(
        context.sessionHistoryBlobs.get(sourceUpload.prepared.body.source_key),
      ).toStrictEqual(sourceUpload.encoded);
      expect(
        context.sessionHistoryBlobs.has(resumed.body.final_history_key),
      ).toBeTruthy();

      const cleaned = await accept(
        apiClient().status({
          params: { handoffId },
          query: { deadline_ms: FUTURE_DEADLINE_MS },
        }),
        [200],
      );
      expect(cleaned.body).toStrictEqual({
        ok: true,
        state: "waiting",
        handoff_pointer_present: false,
      });
      await accept(
        apiClient().resume({
          params: { handoffId },
          body: {
            session_id: sessionId,
            base_history_hash: published.body.base_history_hash,
          },
        }),
        [404],
      );
      const artifactsCleaned = await accept(
        apiClient().cleanupArtifacts({
          params: { handoffId },
          body: {
            base_history_hash: published.body.base_history_hash,
            base_history_encoding: encoding,
            final_history_hash: resumed.body.final_history_hash,
          },
        }),
        [200],
      );
      expect(artifactsCleaned.body.cleanup_completed).toBeTruthy();
      expect(
        context.sessionHistoryBlobs.has(sourceUpload.prepared.body.source_key),
      ).toBeFalsy();
      expect(
        context.sessionHistoryBlobs.has(resumed.body.final_history_key),
      ).toBeFalsy();
    }
  });

  it("rejects corrupt or misidentified H0 before publishing a pointer", async () => {
    const sessionId = randomUUID();
    const jsonl = canonicalJsonl(sessionId);
    const sourceUpload = await prepareSource({
      encoding: SESSION_HISTORY_ENCODING_IDENTITY,
      jsonl,
      sessionId,
    });
    const corrupted = Buffer.from(jsonl);
    corrupted[corrupted.byteLength - 2] = 0x20;
    context.sessionHistoryBlobs.set(
      sourceUpload.prepared.body.source_key,
      corrupted,
    );
    const corruptHandoffId = randomUUID();

    const corrupt = await accept(
      apiClient().publish({
        body: {
          handoff_id: corruptHandoffId,
          source: sourceUpload.source,
          prompt: "must fall back to sandbox",
        },
      }),
      [400],
    );
    expect(corrupt.body.error).toBe("Pi source history hash mismatch");
    expect(recordedPutObjectKeys()).toStrictEqual([]);
    const stillWaiting = await accept(
      apiClient().status({
        params: { handoffId: corruptHandoffId },
        query: { deadline_ms: FUTURE_DEADLINE_MS },
      }),
      [200],
    );
    expect(stillWaiting.body.state).toBe("waiting");

    const validSource = await prepareSource({
      encoding: SESSION_HISTORY_ENCODING_IDENTITY,
      jsonl,
      sessionId: randomUUID(),
    });
    const misidentifiedHandoffId = randomUUID();
    const misidentified = await accept(
      apiClient().publish({
        body: {
          handoff_id: misidentifiedHandoffId,
          source: validSource.source,
          prompt: "must also fall back",
        },
      }),
      [400],
    );
    expect(misidentified.body.error).toBe(
      "Pi source history session ID mismatch",
    );
    expect(recordedPutObjectKeys()).toStrictEqual([]);
  });
});
