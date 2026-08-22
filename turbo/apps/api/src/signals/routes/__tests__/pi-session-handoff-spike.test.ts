import { randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
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

beforeEach(() => {
  const objects = new Map<string, Buffer>();
  mockEnv("ENV", "development");
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      objects.set(
        requiredKey(command.input.Key),
        objectBody(command.input.Body),
      );
      return Promise.resolve({});
    }
    if (command instanceof HeadObjectCommand) {
      const body = objects.get(requiredKey(command.input.Key));
      return body
        ? Promise.resolve({ ContentLength: body.byteLength })
        : Promise.reject(missingObject());
    }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(requiredKey(command.input.Key));
      return body
        ? Promise.resolve({
            Body: bodyStream(body),
            ContentLength: body.byteLength,
          })
        : Promise.reject(missingObject());
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        objects.delete(requiredKey(object.Key));
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

  it("publishes one hash pointer and resumes the native JSONL through R2", async () => {
    const published = await accept(apiClient().publish({ body: {} }), [200]);
    expect(published.body.canonical_history_hash).not.toBe(
      published.body.handoff_history_hash,
    );
    expect(published.body.filesystem_materialized).toBeFalsy();

    const ready = await accept(
      apiClient().status({
        params: { handoffId: published.body.handoff_id },
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
        params: { handoffId: published.body.handoff_id },
        query: { deadline_ms: 0 },
      }),
      [200],
    );
    expect(expired.body).toStrictEqual({
      ok: true,
      state: "timeout",
      handoff_pointer_present: true,
    });

    const resumed = await accept(
      apiClient().resume({
        params: { handoffId: published.body.handoff_id },
        body: {},
      }),
      [200],
    );
    expect(resumed.body.session_id).toBe(published.body.session_id);
    expect(resumed.body.source_history_hash).toBe(
      published.body.handoff_history_hash,
    );
    expect(resumed.body.downloaded_history_hash).toBe(
      resumed.body.source_history_hash,
    );
    expect(resumed.body.final_downloaded_history_hash).toBe(
      resumed.body.final_history_hash,
    );
    expect(resumed.body.final_history_hash).not.toBe(
      resumed.body.source_history_hash,
    );
    expect(resumed.body.final_history_bytes).toBeGreaterThan(
      resumed.body.source_history_bytes,
    );
    expect(resumed.body.tool_results).toBe(1);
    expect(resumed.body.cleanup_completed).toBeTruthy();

    const cleaned = await accept(
      apiClient().status({
        params: { handoffId: published.body.handoff_id },
        query: { deadline_ms: FUTURE_DEADLINE_MS },
      }),
      [200],
    );
    expect(cleaned.body).toStrictEqual({
      ok: true,
      state: "waiting",
      handoff_pointer_present: false,
    });
  });
});
