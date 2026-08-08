import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  cronProjectChatEventSearchContract,
  cronSnapshotChatEventsContract,
} from "@vm0/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  readChatEventSnapshotHead,
  setChatEventSnapshotHeadAsV1,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);

const CRON_SECRET = "test-cron-secret";
const OBJECT_KEY_PATTERN =
  /^chat-events\/([0-9a-f-]{36})\/(\d+)-([0-9a-f]{64})\.ndjson\.gz$/;

interface RecordedPut {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

function snapshotCronClient() {
  return setupApp({ context, routes: cronSnapshotChatEventsRoutes })(
    cronSnapshotChatEventsContract,
  );
}

async function runSnapshotCron() {
  const response = await accept(
    snapshotCronClient().snapshot({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
  return response.body;
}

async function projectChatEventSearch(): Promise<void> {
  const client = setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
  await accept(
    client.project({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
  },
): Promise<string> {
  await api.ensureOrgModelProvider(actor);
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected a no-credit send without a run");
  }
  return sent.body.threadId;
}

interface ArchivedLine {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: string;
  readonly seqId: number;
  readonly createdAt: string;
}

const ARCHIVE_V2_KEYS = [
  "chatThreadId",
  "content",
  "contextId",
  "contextType",
  "createdAt",
  "error",
  "eventType",
  "id",
  "interruptsRunId",
  "revokesEventId",
  "runEventId",
  "runEventSequenceNumber",
  "runGroupId",
  "runId",
  "seqId",
  "thinking",
  "usagePayload",
  "userMessage",
] as const;

const REMOVED_ARCHIVE_V1_KEYS = [
  "activeInputSequence",
  "attachFiles",
  "generationTemplate",
  "goalEvent",
  "recommendedFollowups",
] as const;

function archivedLines(body: Buffer): readonly ArchivedLine[] {
  const raw = gunzipSync(body).toString("utf8");
  expect(raw.endsWith("\n")).toBeTruthy();
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      return JSON.parse(line) as ArchivedLine;
    });
}

function expectArchiveInvariants(
  put: RecordedPut,
  threadId: string,
): readonly ArchivedLine[] {
  const match = OBJECT_KEY_PATTERN.exec(put.key);
  expect(match?.[1]).toBe(threadId);
  expect(put.bucket).toBe("test-user-storages");
  expect(put.contentType).toBe("application/gzip");
  expect(match?.[3]).toBe(createHash("sha256").update(put.body).digest("hex"));

  const lines = archivedLines(put.body);
  expect(lines.length).toBeGreaterThan(0);
  const lastLine = lines[lines.length - 1];
  expect(String(lastLine?.seqId)).toBe(match?.[2]);
  for (const [index, line] of lines.entries()) {
    expect(Object.keys(line).sort()).toStrictEqual(ARCHIVE_V2_KEYS);
    for (const removedKey of REMOVED_ARCHIVE_V1_KEYS) {
      expect(line).not.toHaveProperty(removedKey);
    }
    expect(line.eventType).not.toBe("browser.started");
    expect(line.eventType).not.toBe("browser.stopped");
    expect(line.chatThreadId).toBe(threadId);
    expect(Number.isInteger(line.seqId)).toBeTruthy();
    expect(Number.isNaN(Date.parse(line.createdAt))).toBeFalsy();
    const previous = lines[index - 1];
    if (previous !== undefined) {
      expect(line.seqId).toBeGreaterThan(previous.seqId);
    }
  }
  return lines;
}

function v1SnapshotFixture(
  source: RecordedPut,
  retiredBrowserEventType: "browser.started" | "browser.stopped",
): {
  readonly body: Buffer;
  readonly canonicalLines: readonly ArchivedLine[];
  readonly key: string;
} {
  const sourceLines = archivedLines(source.body);
  const v1Lines = sourceLines.map((line, index) => {
    return {
      ...line,
      eventType: index === 0 ? retiredBrowserEventType : line.eventType,
      activeInputSequence: null,
      attachFiles: null,
      generationTemplate: null,
      goalEvent: null,
      recommendedFollowups: null,
    };
  });
  const raw = `${v1Lines
    .map((line) => {
      return JSON.stringify(line);
    })
    .join("\n")}\n`;
  const body = gzipSync(Buffer.from(raw));
  const lastSeqId = sourceLines.at(-1)?.seqId;
  if (lastSeqId === undefined) {
    throw new Error("Expected a non-empty source snapshot");
  }
  const threadId = sourceLines[0]?.chatThreadId;
  if (threadId === undefined) {
    throw new Error("Expected a source snapshot thread");
  }
  const key = `chat-events/${threadId}/${lastSeqId}-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
  const canonicalEventType =
    retiredBrowserEventType === "browser.started"
      ? "browser.open"
      : "browser.close";
  return {
    body,
    canonicalLines: sourceLines.map((line, index) => {
      return index === 0 ? { ...line, eventType: canonicalEventType } : line;
    }),
    key,
  };
}

describe("cron snapshot chat events", () => {
  /**
   * In-memory R2 for chat-events keys. The object map outlives individual
   * tests on purpose: the test database is shared with concurrently running
   * files, so a later cron pass in this file may legitimately re-download a
   * head object that an earlier test in this file published for an unrelated
   * thread.
   */
  const fakeR2Objects = new Map<string, Buffer>();
  const recordedPuts: RecordedPut[] = [];

  function installFakeR2(): void {
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const record = command as {
        readonly constructor: { readonly name: string };
        readonly input?: {
          readonly Bucket?: string;
          readonly Key?: string;
          readonly Body?: unknown;
          readonly ContentType?: string;
        };
      };
      const key = record.input?.Key;
      if (key?.startsWith("chat-events/") === true) {
        if (record.constructor.name === "PutObjectCommand") {
          const body = record.input?.Body;
          if (!Buffer.isBuffer(body)) {
            throw new Error("expected a Buffer body for chat-events puts");
          }
          fakeR2Objects.set(key, body);
          recordedPuts.push({
            bucket: record.input?.Bucket ?? "",
            key,
            contentType: record.input?.ContentType,
            body,
          });
          return Promise.resolve({});
        }
        if (record.constructor.name === "GetObjectCommand") {
          const stored = fakeR2Objects.get(key);
          if (stored === undefined) {
            return Promise.reject(new Error(`missing fake R2 object: ${key}`));
          }
          return Promise.resolve({
            Body: Readable.from([stored]),
            ContentLength: stored.length,
          });
        }
      }
      return Promise.resolve({ ContentLength: 1024 });
    });
  }

  function putsForThread(threadId: string): readonly RecordedPut[] {
    return recordedPuts.filter((put) => {
      return put.key.startsWith(`chat-events/${threadId}/`);
    });
  }

  beforeEach(() => {
    installFakeR2();
    recordedPuts.length = 0;
    // Drain every candidate thread in the shared test database in one pass so
    // assertions about this file's threads never depend on batch ordering.
    mockOptionalEnv("CHAT_EVENT_SNAPSHOT_BATCH_SIZE", "10000");
    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "10000");
  });

  it("requires the cron secret", async () => {
    const response = await accept(
      snapshotCronClient().snapshot({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("archives full-thread snapshots and extends them from the parent object", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot agent",
    });
    const marker = `archive-${randomUUID()}`;

    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} first`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} second`,
    });
    await projectChatEventSearch();

    const first = await runSnapshotCron();
    expect(first.success).toBeTruthy();
    expect(first.snapshots).toBeGreaterThanOrEqual(1);

    const firstPuts = putsForThread(threadId);
    expect(firstPuts).toHaveLength(1);
    const firstPut = firstPuts[0];
    if (firstPut === undefined) {
      throw new Error("Expected a first-generation snapshot object");
    }
    const firstLines = expectArchiveInvariants(firstPut, threadId);
    const firstRaw = gunzipSync(firstPut.body).toString("utf8");
    expect(firstRaw).toContain(`${marker} first`);
    expect(firstRaw).toContain(`${marker} second`);
    const firstHead = await readChatEventSnapshotHead(context, threadId);
    expect(firstHead.archive_schema_version).toBe(2);
    expect(firstHead.object_key).toBe(firstPut.key);

    // Nothing new to archive: the same pass again must not touch the thread.
    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(1);

    // Recreate the active head as a verified historical v1 object. Its first
    // row also exercises the retired browser value mapping during transcode.
    const v1Parent = v1SnapshotFixture(firstPut, "browser.started");
    fakeR2Objects.set(v1Parent.key, v1Parent.body);
    await setChatEventSnapshotHeadAsV1(context, threadId, v1Parent.key);

    // A new Postgres tail beyond the projected watermark triggers a rebuild
    // that transcodes the v1 parent and appends v2 tail rows.
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} third`,
    });
    await projectChatEventSearch();
    const second = await runSnapshotCron();
    expect(second.success).toBeTruthy();

    const secondPuts = putsForThread(threadId);
    expect(secondPuts).toHaveLength(2);
    const secondPut = secondPuts[1];
    if (secondPut === undefined) {
      throw new Error("Expected a second-generation snapshot object");
    }
    const secondLines = expectArchiveInvariants(secondPut, threadId);
    expect(secondLines.length).toBeGreaterThan(firstLines.length);
    expect(secondLines.slice(0, firstLines.length)).toStrictEqual(
      v1Parent.canonicalLines,
    );

    const secondRaw = gunzipSync(secondPut.body).toString("utf8");
    expect(secondRaw).toContain(`${marker} third`);
    const secondHead = await readChatEventSnapshotHead(context, threadId);
    expect(secondHead.archive_schema_version).toBe(2);
    expect(secondHead.object_key).toBe(secondPut.key);

    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);

  it("upgrades a v1 head to homogeneous v2 without a Postgres tail", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Version-only snapshot agent",
    });

    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `version-only-${randomUUID()}`,
    });
    await projectChatEventSearch();
    await runSnapshotCron();

    const firstPut = putsForThread(threadId)[0];
    if (firstPut === undefined) {
      throw new Error("Expected a first-generation snapshot object");
    }
    const firstHead = await readChatEventSnapshotHead(context, threadId);
    const v1Parent = v1SnapshotFixture(firstPut, "browser.stopped");
    fakeR2Objects.set(v1Parent.key, v1Parent.body);
    await setChatEventSnapshotHeadAsV1(context, threadId, v1Parent.key);

    const upgraded = await runSnapshotCron();
    expect(upgraded.success).toBeTruthy();
    const puts = putsForThread(threadId);
    expect(puts).toHaveLength(2);
    const upgradedPut = puts[1];
    if (upgradedPut === undefined) {
      throw new Error("Expected a version-only v2 snapshot object");
    }
    const upgradedLines = expectArchiveInvariants(upgradedPut, threadId);
    expect(upgradedLines).toStrictEqual(v1Parent.canonicalLines);

    const upgradedHead = await readChatEventSnapshotHead(context, threadId);
    expect(upgradedHead.archive_schema_version).toBe(2);
    expect(upgradedHead.last_seq_id).toBe(firstHead.last_seq_id);
    expect(upgradedHead.object_key).toBe(upgradedPut.key);

    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);

  it("fails the pass when a parent object no longer matches its content hash", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Corruption agent",
    });

    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `corruption-${randomUUID()}`,
    });
    await projectChatEventSearch();
    await runSnapshotCron();

    const headPut = putsForThread(threadId)[0];
    if (headPut === undefined) {
      throw new Error("Expected a head snapshot object to corrupt");
    }
    const corrupted = Buffer.from(headPut.body);
    const lastByte = corrupted.at(-1);
    if (lastByte === undefined) {
      throw new Error("Expected a non-empty snapshot object");
    }
    corrupted[corrupted.length - 1] = lastByte ^ 0xff;
    fakeR2Objects.set(headPut.key, corrupted);

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `corruption-tail-${randomUUID()}`,
    });
    await projectChatEventSearch();
    const failed = await accept(
      snapshotCronClient().snapshot({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [500],
    );
    expect(failed.body).toStrictEqual({ error: "Internal server error" });
    expect(putsForThread(threadId)).toHaveLength(1);

    // Restoring the object bytes lets the next pass archive the thread again,
    // and keeps the shared database healthy for the remaining tests.
    fakeR2Objects.set(headPut.key, headPut.body);
    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);
});
