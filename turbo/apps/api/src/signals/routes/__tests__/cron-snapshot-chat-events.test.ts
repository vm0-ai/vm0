import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  cronProjectChatEventSearchContract,
  cronSnapshotChatEventsContract,
} from "@vm0/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  installFakeChatEventR2,
  readFakeChatEventObject,
  writeFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import {
  advanceChatEventSequenceAsPreviousApi,
  readChatEventSnapshotHead,
  setChatEventSnapshotHeadVersion,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);

const CRON_SECRET = "test-cron-secret";
const NON_CURRENT_ARCHIVE_SCHEMA_VERSION = 1;
const OBJECT_KEY_PATTERN =
  /^chat-events\/([0-9a-f-]{36})\/(\d+)-([0-9a-f]{64})\.ndjson\.gz$/;

type RecordedPut = RecordedChatEventPut;

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

const ARCHIVE_V4_KEYS = [
  "chatThreadId",
  "contextId",
  "contextType",
  "createdAt",
  "eventType",
  "id",
  "payload",
  "revokesEventId",
  "runEventId",
  "runEventSequenceNumber",
  "runId",
  "seqId",
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
  lastPhysicalSeqId?: number,
): readonly ArchivedLine[] {
  const match = OBJECT_KEY_PATTERN.exec(put.key);
  expect(match?.[1]).toBe(threadId);
  expect(put.bucket).toBe("test-user-storages");
  expect(put.contentType).toBe("application/x-ndjson");
  expect(put.contentEncoding).toBe("gzip");
  expect(match?.[3]).toBe(createHash("sha256").update(put.body).digest("hex"));

  const lines = archivedLines(put.body);
  expect(lines.length).toBeGreaterThan(0);
  const lastLine = lines[lines.length - 1];
  expect(lastLine?.seqId).toBe(lastPhysicalSeqId ?? Number(match?.[2]));
  for (const [index, line] of lines.entries()) {
    expect(Object.keys(line).sort()).toStrictEqual(ARCHIVE_V4_KEYS);
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

describe("cron snapshot chat events", () => {
  const recordedPuts: RecordedPut[] = [];

  function putsForThread(threadId: string): readonly RecordedPut[] {
    return recordedPuts.filter((put) => {
      return put.key.startsWith(`chat-events/${threadId}/`);
    });
  }

  beforeEach(() => {
    installFakeChatEventR2(context, recordedPuts);
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

  it("rebuilds canonical full-thread snapshots from database rows", async () => {
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
    expect(firstHead.archive_schema_version).toBe(4);
    expect(firstHead.object_key).toBe(firstPut.key);

    // Nothing new to archive: the same pass again must not touch the thread.
    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(1);

    // A new Postgres tail beyond the projected watermark triggers another
    // generation seeded by the head object, preserving ordering and prior
    // history byte for byte.
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
    expect(secondLines.slice(0, firstLines.length)).toStrictEqual(firstLines);

    const secondRaw = gunzipSync(secondPut.body).toString("utf8");
    expect(secondRaw).toContain(`${marker} third`);
    const secondHead = await readChatEventSnapshotHead(context, threadId);
    expect(secondHead.archive_schema_version).toBe(4);
    expect(secondHead.object_key).toBe(secondPut.key);

    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);

  it("publishes sparse indexed coverage and tails later rows", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Sparse snapshot agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `sparse-snapshot-${randomUUID()}`,
    });
    const initialRows = await chat.listThreadEventRows(owner, threadId);
    const lastPhysicalRow = initialRows.at(-1);
    if (lastPhysicalRow === undefined) {
      throw new Error("Expected a physical chat event before the sparse tail");
    }
    const coveredSeqId = lastPhysicalRow.seqId + 1;

    await advanceChatEventSequenceAsPreviousApi(context, threadId, 1);
    await projectChatEventSearch();
    const result = await runSnapshotCron();
    expect(result.success).toBeTruthy();

    const put = putsForThread(threadId)[0];
    if (put === undefined) {
      throw new Error("Expected a sparse-coverage snapshot object");
    }
    expectArchiveInvariants(put, threadId, lastPhysicalRow.seqId);
    expect(OBJECT_KEY_PATTERN.exec(put.key)?.[2]).toBe(coveredSeqId.toString());
    const head = await readChatEventSnapshotHead(context, threadId);
    expect(head.last_seq_id).toBe(coveredSeqId);

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `sparse-snapshot-tail-${randomUUID()}`,
    });
    const tail = await chat.listThreadEventRows(owner, threadId, coveredSeqId);
    expect(tail.length).toBeGreaterThan(0);
    expect(
      tail.map((row) => {
        return row.seqId;
      }),
    ).toStrictEqual(
      tail.map((_, index) => {
        return coveredSeqId + index + 1;
      }),
    );
  }, 60_000);

  it("rebuilds an idle non-v4 head and reports convergence", async () => {
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
    const priorObjectKey = `chat-events/${threadId}/non-v4-${randomUUID()}.ndjson.gz`;
    writeFakeChatEventObject(priorObjectKey, firstPut.body);
    await setChatEventSnapshotHeadVersion(
      context,
      threadId,
      NON_CURRENT_ARCHIVE_SCHEMA_VERSION,
      priorObjectKey,
    );

    const rebuilt = await runSnapshotCron();
    expect(rebuilt.success).toBeTruthy();
    expect(rebuilt.nonV4SnapshotHeads).toBe(0);
    expect(putsForThread(threadId)).toHaveLength(2);
    const rebuiltHead = await readChatEventSnapshotHead(context, threadId);
    expect(rebuiltHead.archive_schema_version).toBe(4);
    expect(rebuiltHead.object_key).toBe(firstPut.key);

    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);

  it("falls back to a canonical rebuild when the head object is damaged", async () => {
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
    writeFakeChatEventObject(headPut.key, corrupted);

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `corruption-tail-${randomUUID()}`,
    });
    await projectChatEventSearch();
    const rebuilt = await runSnapshotCron();
    expect(rebuilt.success).toBeTruthy();
    expect(putsForThread(threadId)).toHaveLength(2);
    const rebuiltHead = await readChatEventSnapshotHead(context, threadId);
    expect(rebuiltHead.object_key).not.toBe(headPut.key);
  }, 60_000);

  it("reclaims retired heads while a bounded rebuild resumes", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Resumable snapshot agent",
    });
    const threadIds = await Promise.all(
      ["first", "second"].map(async (suffix) => {
        return await sendNoCreditMessage(owner, {
          agentId: agent.agentId,
          prompt: `resumable-${suffix}-${randomUUID()}`,
        });
      }),
    );
    await projectChatEventSearch();
    await runSnapshotCron();

    const retiredObjectKeys: string[] = [];
    for (const threadId of threadIds) {
      const head = await readChatEventSnapshotHead(context, threadId);
      const priorObjectKey = `chat-events/${threadId}/non-v4-${randomUUID()}.ndjson.gz`;
      const body = readFakeChatEventObject(head.object_key);
      if (body === undefined) {
        throw new Error("Expected the v4 fixture object");
      }
      writeFakeChatEventObject(priorObjectKey, body);
      retiredObjectKeys.push(priorObjectKey);
      await setChatEventSnapshotHeadVersion(
        context,
        threadId,
        NON_CURRENT_ARCHIVE_SCHEMA_VERSION,
        priorObjectKey,
      );
    }

    mockOptionalEnv("CHAT_EVENT_SNAPSHOT_BATCH_SIZE", "1");
    const firstPass = await runSnapshotCron();
    expect(firstPass).toMatchObject({
      snapshots: 1,
      nonV4SnapshotHeads: 0,
    });
    expect(firstPass.retiredSnapshotReferencesDeleted).toBeGreaterThanOrEqual(
      2,
    );
    for (const objectKey of retiredObjectKeys) {
      expect(readFakeChatEventObject(objectKey)).toBeUndefined();
    }

    const secondPass = await runSnapshotCron();
    expect(secondPass).toMatchObject({
      snapshots: 1,
      nonV4SnapshotHeads: 0,
    });
    for (const threadId of threadIds) {
      const head = await readChatEventSnapshotHead(context, threadId);
      expect(head.archive_schema_version).toBe(4);
    }
  }, 90_000);

  it("uses the exact parent metadata as a publication CAS", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot CAS agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-cas-${randomUUID()}`,
    });
    await projectChatEventSearch();
    await runSnapshotCron();
    const parentHead = await readChatEventSnapshotHead(context, threadId);

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-cas-tail-${randomUUID()}`,
    });
    await projectChatEventSearch();

    const publicationGate = createDeferredPromise<void>(context.signal);
    let arrivals = 0;
    installFakeChatEventR2(context, recordedPuts, async (put) => {
      if (!put.key.startsWith(`chat-events/${threadId}/`)) {
        return;
      }
      arrivals += 1;
      if (arrivals === 2 && !publicationGate.settled()) {
        publicationGate.resolve(undefined);
      }
      await publicationGate.promise;
    });

    await Promise.all([runSnapshotCron(), runSnapshotCron()]);
    expect(arrivals).toBe(2);
    const head = await readChatEventSnapshotHead(context, threadId);
    // Cron result counts cover every candidate in the shared test database;
    // the persisted generation count scopes the CAS assertion to this thread.
    expect(head.snapshot_count).toBe(parentHead.snapshot_count + 1);
    expect(head.archive_schema_version).toBe(4);
    expect(head.last_seq_id).toBeGreaterThan(parentHead.last_seq_id);
    expect(head.object_key).not.toBe(parentHead.object_key);
  }, 90_000);
});
