import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { cronSnapshotChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import {
  validate as validateUuid,
  version as uuidVersion,
  v5 as uuidv5,
} from "uuid";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  installFakeChatEventR2,
  writeFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import {
  advanceChatEventSequenceAsPreviousApi,
  readChatEventSnapshotHead,
  updateChatEventSnapshotHead,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);

const DUPLICATE_EVENT_ID_NAMESPACE = "46842b1d-a596-47fb-86b3-4f51962751c7";
const DUPLICATE_EVENT_ID_WARNING =
  "Normalized duplicate chat event IDs in snapshot";
const SNAPSHOT_COMPLETED_MESSAGE = "Completed chat event snapshot";
const SNAPSHOT_COMPLETED_TYPE = "chat_event_snapshot_completed";
const OBJECT_KEY_PATTERN =
  /^chat-events\/([0-9a-f-]{36})\/(\d+)-([0-9a-f]{64})\.ndjson\.gz$/;

type RecordedPut = RecordedChatEventPut;

function snapshotCronClient() {
  return setupApp({ context, routes: cronSnapshotChatEventsRoutes })(
    cronSnapshotChatEventsContract,
  );
}

async function runSnapshotCron(
  chatThreadIds: readonly string[],
  r2ObjectKeys: readonly string[] = [],
) {
  const client = setupApp({
    context,
    routes: testChatEventSnapshotRoutes,
  })(testChatEventSnapshotContract);
  const response = await accept(
    client.snapshot({
      body: {
        chat_thread_ids: [...chatThreadIds],
        r2_object_keys: [...r2ObjectKeys],
      },
    }),
    [200],
  );
  return response.body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotCompletionEvents(): readonly Record<string, unknown>[] {
  return context.mocks.axiom.ingest.mock.calls.flatMap(([dataset, events]) => {
    if (dataset !== "web-logs" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event) && event.type === SNAPSHOT_COMPLETED_TYPE;
    });
  });
}

function expectSnapshotCompletion(expected: {
  readonly duplicateEventIdConflictThreads: number;
  readonly duplicateEventIdConflicts: number;
  readonly duplicateEventIdsRemapped: number;
  readonly duplicateEventReferencesRemapped: number;
}): void {
  const events = snapshotCompletionEvents();
  expect(events).toHaveLength(1);
  const event = events[0];
  expect({
    level: event?.level,
    message: event?.message,
    source: event?.source,
    type: event?.type,
    context: event?.context,
    duplicateEventIdConflictThreads: event?.duplicateEventIdConflictThreads,
    duplicateEventIdConflicts: event?.duplicateEventIdConflicts,
    duplicateEventIdsRemapped: event?.duplicateEventIdsRemapped,
    duplicateEventReferencesRemapped: event?.duplicateEventReferencesRemapped,
  }).toStrictEqual({
    level: "info",
    message: SNAPSHOT_COMPLETED_MESSAGE,
    source: "api",
    type: SNAPSHOT_COMPLETED_TYPE,
    context: "api:cron:snapshot-chat-events",
    ...expected,
  });
}

async function projectChatEventSearch(...chatThreadIds: readonly string[]) {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  const response = await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
  return response.body;
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
    readonly clientEventId?: string;
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
  readonly revokesEventId: string | null;
  readonly eventType: string;
  readonly seqId: number;
  readonly createdAt: string;
}

const CANONICAL_ARCHIVE_KEYS = [
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

interface DuplicateParentFixture {
  readonly objectKey: string;
  readonly occurrenceSeqIds: readonly number[];
  readonly referenceSeqIds: readonly number[];
}

function duplicateParentFixture(
  put: RecordedPut,
  threadId: string,
  duplicateId: string,
  occurrenceCount: number,
): DuplicateParentFixture {
  const lines = archivedLines(put.body);
  const occurrences = lines
    .filter((line) => {
      return line.eventType === "input.prompt";
    })
    .slice(0, occurrenceCount);
  if (occurrences.length !== occurrenceCount) {
    throw new Error("Expected enough input.prompt snapshot fixture rows");
  }
  const originalIds = new Set(
    occurrences.map((occurrence) => {
      return occurrence.id;
    }),
  );
  const references = occurrences.map((occurrence) => {
    const reference = lines.find((line) => {
      return (
        line.seqId > occurrence.seqId && line.revokesEventId === occurrence.id
      );
    });
    if (!reference) {
      throw new Error("Expected a historical reference after each occurrence");
    }
    return reference;
  });
  const rewritten = lines.map((line) => {
    return {
      ...line,
      id: originalIds.has(line.id) ? duplicateId : line.id,
      revokesEventId:
        line.revokesEventId !== null && originalIds.has(line.revokesEventId)
          ? duplicateId
          : line.revokesEventId,
    };
  });
  const body = gzipSync(
    Buffer.from(
      rewritten
        .map((line) => {
          return `${JSON.stringify(line)}\n`;
        })
        .join(""),
    ),
  );
  const lastSeqId = rewritten.at(-1)?.seqId;
  if (lastSeqId === undefined) {
    throw new Error("Expected a non-empty duplicate snapshot fixture");
  }
  const objectKey = `chat-events/${threadId}/${lastSeqId.toString()}-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
  writeFakeChatEventObject(objectKey, body);
  return {
    objectKey,
    occurrenceSeqIds: occurrences.map((occurrence) => {
      return occurrence.seqId;
    }),
    referenceSeqIds: references.map((reference) => {
      return reference.seqId;
    }),
  };
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
    expect(Object.keys(line).sort()).toStrictEqual(CANONICAL_ARCHIVE_KEYS);
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

  it("bootstraps once from Raw Events, then appends tails to the Snapshot", async () => {
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
    await projectChatEventSearch(threadId);

    const first = await runSnapshotCron([threadId]);
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
    expect(firstHead.archive_schema_version).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    );
    expect(firstHead.last_event_id).toBe(firstLines.at(-1)?.id);
    expect(firstHead.object_key).toBe(firstPut.key);

    // Nothing new to archive: the same pass again must not touch the thread.
    await runSnapshotCron([threadId]);
    expect(putsForThread(threadId)).toHaveLength(1);

    // A new Postgres tail beyond the projected watermark triggers another
    // generation seeded by the head object, preserving ordering and prior
    // history byte for byte.
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} third`,
    });
    await projectChatEventSearch(threadId);
    const second = await runSnapshotCron([threadId]);
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
    expect(secondHead.archive_schema_version).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    );
    expect(secondHead.last_event_id).toBe(secondLines.at(-1)?.id);
    expect(secondHead.object_key).toBe(secondPut.key);

    await runSnapshotCron([threadId]);
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);

  it("keeps no-conflict prefix and tail bytes and observability unchanged", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "No-conflict snapshot agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `no-conflict-prefix-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);

    const parentPut = putsForThread(threadId)[0];
    if (parentPut === undefined) {
      throw new Error("Expected a no-conflict parent snapshot");
    }
    const parentHead = await readChatEventSnapshotHead(context, threadId);
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `no-conflict-tail-${randomUUID()}`,
    });
    const tailRows = await chat.listThreadEventRows(owner, threadId, {
      lastEventId: parentHead.last_event_id,
      lastSeqId: parentHead.last_seq_id,
      projection: "tool-redacted",
    });
    await projectChatEventSearch(threadId);

    const expectedBody = gzipSync(
      Buffer.concat([
        gunzipSync(parentPut.body),
        Buffer.from(
          tailRows
            .map((row) => {
              return `${JSON.stringify(row)}\n`;
            })
            .join(""),
        ),
      ]),
    );
    context.mocks.axiomLogging.warn.mockClear();
    context.mocks.axiom.ingest.mockClear();

    const result = await runSnapshotCron([threadId]);
    expect(result).toMatchObject({
      duplicateEventIdConflictThreads: 0,
      duplicateEventIdConflicts: 0,
      duplicateEventIdsRemapped: 0,
      duplicateEventReferencesRemapped: 0,
    });
    expectSnapshotCompletion({
      duplicateEventIdConflictThreads: 0,
      duplicateEventIdConflicts: 0,
      duplicateEventIdsRemapped: 0,
      duplicateEventReferencesRemapped: 0,
    });
    const nextPut = putsForThread(threadId)[1];
    if (nextPut === undefined) {
      throw new Error("Expected a no-conflict child snapshot");
    }
    expect(nextPut.body).toStrictEqual(expectedBody);
    expect(
      context.mocks.axiomLogging.warn.mock.calls.some((call) => {
        return call[0] === DUPLICATE_EVENT_ID_WARNING;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("does not log completion when snapshotting fails", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Failing snapshot agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `failing-snapshot-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);

    const snapshotFailure = new Error("Forced snapshot R2 write failure");
    installFakeChatEventR2(context, recordedPuts, () => {
      return Promise.reject(snapshotFailure);
    });
    context.mocks.axiom.ingest.mockClear();

    await expect(runSnapshotCron([threadId])).rejects.toThrow(
      "Unknown response status 500",
    );
    expect(snapshotCompletionEvents()).toHaveLength(0);
  }, 60_000);

  it("normalizes duplicate IDs and their resolved historical references deterministically", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Duplicate snapshot agent",
    });
    const duplicateId = randomUUID();
    const firstMarker = `duplicate-first-${randomUUID()}`;
    const secondMarker = `duplicate-second-${randomUUID()}`;

    const firstThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${firstMarker}-one`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: firstThreadId,
      prompt: `${firstMarker}-two`,
    });
    const secondThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${secondMarker}-one`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: secondThreadId,
      prompt: `${secondMarker}-two`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: secondThreadId,
      prompt: `${secondMarker}-three`,
    });
    await projectChatEventSearch(firstThreadId, secondThreadId);
    await runSnapshotCron([firstThreadId, secondThreadId]);

    const firstParentPut = putsForThread(firstThreadId)[0];
    const secondParentPut = putsForThread(secondThreadId)[0];
    if (firstParentPut === undefined || secondParentPut === undefined) {
      throw new Error("Expected both duplicate parent snapshots");
    }
    const firstFixture = duplicateParentFixture(
      firstParentPut,
      firstThreadId,
      duplicateId,
      2,
    );
    const secondFixture = duplicateParentFixture(
      secondParentPut,
      secondThreadId,
      duplicateId,
      3,
    );
    expect(firstFixture.occurrenceSeqIds).toStrictEqual(
      secondFixture.occurrenceSeqIds.slice(0, 2),
    );
    await updateChatEventSnapshotHead(
      context,
      firstThreadId,
      firstFixture.objectKey,
    );
    await updateChatEventSnapshotHead(
      context,
      secondThreadId,
      secondFixture.objectKey,
    );

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: firstThreadId,
      prompt: `${firstMarker}-newest`,
      clientEventId: duplicateId,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: secondThreadId,
      prompt: `${secondMarker}-tail`,
      clientEventId: randomUUID(),
    });
    await projectChatEventSearch(firstThreadId, secondThreadId);

    context.mocks.axiomLogging.warn.mockClear();
    const publicationGate = createDeferredPromise<void>(context.signal);
    let firstThreadArrivals = 0;
    installFakeChatEventR2(context, recordedPuts, async (put) => {
      if (!put.key.startsWith(`chat-events/${firstThreadId}/`)) {
        return;
      }
      firstThreadArrivals += 1;
      if (firstThreadArrivals === 2 && !publicationGate.settled()) {
        publicationGate.resolve(undefined);
      }
      await publicationGate.promise;
    });

    const retryResults = await Promise.all([
      runSnapshotCron([firstThreadId]),
      runSnapshotCron([firstThreadId]),
    ]);
    for (const result of retryResults) {
      expect(result).toMatchObject({
        duplicateEventIdConflictThreads: 1,
        duplicateEventIdConflicts: 1,
        duplicateEventIdsRemapped: 2,
        duplicateEventReferencesRemapped: 2,
      });
    }

    const firstRetryPuts = putsForThread(firstThreadId).slice(1);
    expect(firstRetryPuts.length).toBeGreaterThanOrEqual(2);
    const firstRetryPut = firstRetryPuts[0];
    const secondRetryPut = firstRetryPuts[1];
    if (firstRetryPut === undefined || secondRetryPut === undefined) {
      throw new Error("Expected two duplicate normalization retry objects");
    }
    expect(secondRetryPut.key).toBe(firstRetryPut.key);
    expect(secondRetryPut.body).toStrictEqual(firstRetryPut.body);
    const retryHead = await readChatEventSnapshotHead(context, firstThreadId);
    expect(retryHead).toMatchObject({
      archive_schema_version: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      snapshot_count: 1,
    });

    const firstLines = expectArchiveInvariants(firstRetryPut, firstThreadId);
    const firstBySeqId = new Map(
      firstLines.map((line) => {
        return [line.seqId, line] as const;
      }),
    );
    const firstRemappedIds = firstFixture.occurrenceSeqIds.map((seqId) => {
      return uuidv5(
        `${firstThreadId}:${seqId.toString()}:${duplicateId}`,
        DUPLICATE_EVENT_ID_NAMESPACE,
      );
    });
    expect(
      firstFixture.occurrenceSeqIds.map((seqId) => {
        return firstBySeqId.get(seqId)?.id;
      }),
    ).toStrictEqual(firstRemappedIds);
    expect(
      firstFixture.referenceSeqIds.map((seqId) => {
        return firstBySeqId.get(seqId)?.revokesEventId;
      }),
    ).toStrictEqual(firstRemappedIds);
    expect(new Set(firstRemappedIds).size).toBe(2);
    for (const remappedId of firstRemappedIds) {
      expect(validateUuid(remappedId)).toBeTruthy();
      expect(uuidVersion(remappedId)).toBe(5);
    }
    const firstRetained = firstLines.filter((line) => {
      return line.id === duplicateId;
    });
    expect(firstRetained).toHaveLength(1);
    const retainedFirstOccurrence = firstRetained[0];
    if (retainedFirstOccurrence === undefined) {
      throw new Error("Expected the newest first-thread occurrence");
    }
    expect(
      firstLines.some((line) => {
        return (
          line.seqId > retainedFirstOccurrence.seqId &&
          line.revokesEventId === duplicateId
        );
      }),
    ).toBeTruthy();

    installFakeChatEventR2(context, recordedPuts);
    context.mocks.axiom.ingest.mockClear();
    const secondResult = await runSnapshotCron([secondThreadId]);
    expect(secondResult).toMatchObject({
      duplicateEventIdConflictThreads: 1,
      duplicateEventIdConflicts: 1,
      duplicateEventIdsRemapped: 2,
      duplicateEventReferencesRemapped: 2,
    });
    expectSnapshotCompletion({
      duplicateEventIdConflictThreads: 1,
      duplicateEventIdConflicts: 1,
      duplicateEventIdsRemapped: 2,
      duplicateEventReferencesRemapped: 2,
    });
    const secondPut = putsForThread(secondThreadId)[1];
    if (secondPut === undefined) {
      throw new Error("Expected a normalized second-thread snapshot");
    }
    const secondLines = expectArchiveInvariants(secondPut, secondThreadId);
    const secondBySeqId = new Map(
      secondLines.map((line) => {
        return [line.seqId, line] as const;
      }),
    );
    const secondRemappedIds = secondFixture.occurrenceSeqIds
      .slice(0, -1)
      .map((seqId) => {
        return uuidv5(
          `${secondThreadId}:${seqId.toString()}:${duplicateId}`,
          DUPLICATE_EVENT_ID_NAMESPACE,
        );
      });
    expect(
      secondFixture.occurrenceSeqIds.slice(0, -1).map((seqId) => {
        return secondBySeqId.get(seqId)?.id;
      }),
    ).toStrictEqual(secondRemappedIds);
    expect(
      secondFixture.referenceSeqIds.slice(0, -1).map((seqId) => {
        return secondBySeqId.get(seqId)?.revokesEventId;
      }),
    ).toStrictEqual(secondRemappedIds);
    const retainedSecondSeqId = secondFixture.occurrenceSeqIds.at(-1);
    const retainedSecondReferenceSeqId = secondFixture.referenceSeqIds.at(-1);
    if (
      retainedSecondSeqId === undefined ||
      retainedSecondReferenceSeqId === undefined
    ) {
      throw new Error("Expected the newest second-thread occurrence fixture");
    }
    expect(secondBySeqId.get(retainedSecondSeqId)?.id).toBe(duplicateId);
    expect(
      secondBySeqId.get(retainedSecondReferenceSeqId)?.revokesEventId,
    ).toBe(duplicateId);
    expect(secondRemappedIds[0]).not.toBe(firstRemappedIds[0]);

    const warningCalls = context.mocks.axiomLogging.warn.mock.calls.filter(
      (call) => {
        return call[0] === DUPLICATE_EVENT_ID_WARNING;
      },
    );
    expect(
      warningCalls.map((call) => {
        const fields = call[1];
        if (typeof fields !== "object" || fields === null) {
          throw new Error("Expected structured duplicate ID warning fields");
        }
        return {
          type: Reflect.get(fields, "type"),
          context: Reflect.get(fields, "context"),
          chatThreadId: Reflect.get(fields, "chatThreadId"),
          conflictingEventIdCount: Reflect.get(
            fields,
            "conflictingEventIdCount",
          ),
          remappedEventIdCount: Reflect.get(fields, "remappedEventIdCount"),
          remappedReferenceCount: Reflect.get(fields, "remappedReferenceCount"),
        };
      }),
    ).toStrictEqual([
      {
        type: "chat_event_snapshot_duplicate_ids_normalized",
        context: "api:cron:snapshot-chat-events",
        chatThreadId: firstThreadId,
        conflictingEventIdCount: 1,
        remappedEventIdCount: 2,
        remappedReferenceCount: 2,
      },
      {
        type: "chat_event_snapshot_duplicate_ids_normalized",
        context: "api:cron:snapshot-chat-events",
        chatThreadId: firstThreadId,
        conflictingEventIdCount: 1,
        remappedEventIdCount: 2,
        remappedReferenceCount: 2,
      },
      {
        type: "chat_event_snapshot_duplicate_ids_normalized",
        context: "api:cron:snapshot-chat-events",
        chatThreadId: secondThreadId,
        conflictingEventIdCount: 1,
        remappedEventIdCount: 2,
        remappedReferenceCount: 2,
      },
    ]);
    expect(JSON.stringify(warningCalls)).not.toContain(firstMarker);
    expect(JSON.stringify(warningCalls)).not.toContain(secondMarker);
    const firstHead = await readChatEventSnapshotHead(context, firstThreadId);
    const secondHead = await readChatEventSnapshotHead(context, secondThreadId);
    expect(firstHead.archive_schema_version).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    );
    expect(secondHead.archive_schema_version).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    );
  }, 180_000);

  it("limits projection and snapshots to explicitly owned threads", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Scoped snapshot agent",
    });
    const ownedThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `scoped-snapshot-owned-${randomUUID()}`,
    });
    const unownedThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `scoped-snapshot-unowned-${randomUUID()}`,
    });

    const projection = await projectChatEventSearch(ownedThreadId);
    expect(projection.threads).toBe(1);
    const snapshot = await runSnapshotCron([ownedThreadId]);
    expect(snapshot.snapshots).toBe(1);
    expect(putsForThread(ownedThreadId)).toHaveLength(1);
    expect(putsForThread(unownedThreadId)).toHaveLength(0);

    const unownedRows = await chat.listThreadEventRows(owner, unownedThreadId);
    expect(unownedRows.length).toBeGreaterThan(0);
  }, 60_000);

  it("publishes sparse streams and indexed coverage before tailing later rows", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Sparse snapshot agent",
    });
    await api.ensureOrgModelProvider(owner);
    const thread = await chat.createThread(owner, {
      agentId: agent.agentId,
      title: "Sparse snapshot thread",
    });
    await advanceChatEventSequenceAsPreviousApi(context, thread.id, 3);
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: thread.id,
      prompt: `sparse-snapshot-${randomUUID()}`,
    });
    const initialRows = await chat.listThreadEventRows(owner, threadId);
    const firstPhysicalRow = initialRows[0];
    const lastPhysicalRow = initialRows.at(-1);
    if (firstPhysicalRow === undefined || lastPhysicalRow === undefined) {
      throw new Error("Expected a physical chat event before the sparse tail");
    }
    expect(firstPhysicalRow.seqId).toBeGreaterThan(1);
    const coveredSeqId = lastPhysicalRow.seqId + 1;

    await advanceChatEventSequenceAsPreviousApi(context, threadId, 1);
    await projectChatEventSearch(threadId);
    const result = await runSnapshotCron([threadId]);
    expect(result.success).toBeTruthy();

    const put = putsForThread(threadId)[0];
    if (put === undefined) {
      throw new Error("Expected a sparse-coverage snapshot object");
    }
    const archived = expectArchiveInvariants(
      put,
      threadId,
      lastPhysicalRow.seqId,
    );
    const firstArchivedRow = archived[0];
    if (firstArchivedRow === undefined) {
      throw new Error("Expected an archived chat event");
    }
    expect(firstArchivedRow.seqId).toBeGreaterThan(1);
    expect(OBJECT_KEY_PATTERN.exec(put.key)?.[2]).toBe(coveredSeqId.toString());
    const head = await readChatEventSnapshotHead(context, threadId);
    expect(head.last_seq_id).toBe(coveredSeqId);

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `sparse-snapshot-tail-${randomUUID()}`,
    });
    const tail = await chat.listThreadEventRows(owner, threadId, {
      lastEventId: head.terminal_event_id ?? head.last_event_id,
      lastSeqId: head.terminal_seq_id ?? coveredSeqId,
      projection: "tool-redacted",
    });
    expect(tail.length).toBeGreaterThan(0);
    let previousSeqId = coveredSeqId;
    for (const row of tail) {
      expect(row.seqId).toBeGreaterThan(previousSeqId);
      previousSeqId = row.seqId;
    }
  }, 60_000);

  it("skips every non-reusable existing head without rebuilding or replacing it", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Fail-closed snapshot agent",
    });
    const fixtures: { readonly kind: string; readonly threadId: string }[] = [];
    for (const kind of ["unreadable", "undecodable", "incomplete"]) {
      const threadId = await sendNoCreditMessage(owner, {
        agentId: agent.agentId,
        prompt: `${kind}-${randomUUID()}`,
      });
      fixtures.push({ kind, threadId });
    }
    const threadIds = fixtures.map((fixture) => {
      return fixture.threadId;
    });
    await projectChatEventSearch(...threadIds);
    await runSnapshotCron(threadIds);

    for (const fixture of fixtures) {
      const initialPut = putsForThread(fixture.threadId)[0];
      if (initialPut === undefined) {
        throw new Error("Expected an initial snapshot object");
      }
      if (fixture.kind === "unreadable") {
        const missingObjectKey = `chat-events/${fixture.threadId}/missing-${randomUUID()}.ndjson.gz`;
        await updateChatEventSnapshotHead(
          context,
          fixture.threadId,
          missingObjectKey,
        );
      } else if (fixture.kind === "undecodable") {
        writeFakeChatEventObject(initialPut.key, Buffer.from("not-gzip"));
      } else {
        await updateChatEventSnapshotHead(
          context,
          fixture.threadId,
          undefined,
          0,
        );
      }

      await sendNoCreditMessage(owner, {
        agentId: agent.agentId,
        threadId: fixture.threadId,
        prompt: `${fixture.kind}-tail-${randomUUID()}`,
      });
    }
    await projectChatEventSearch(...threadIds);
    const blockedHeads = new Map(
      await Promise.all(
        fixtures.map(async (fixture) => {
          return [
            fixture.threadId,
            await readChatEventSnapshotHead(context, fixture.threadId),
          ] as const;
        }),
      ),
    );

    const skipped = await runSnapshotCron(threadIds);
    expect(skipped).toMatchObject({
      snapshots: 0,
      skippedUnreadableHeads: 1,
      skippedUndecodableHeads: 1,
      skippedIncompleteHeads: 1,
      unreadableParents: 2,
    });

    for (const fixture of fixtures) {
      expect(putsForThread(fixture.threadId)).toHaveLength(1);
      const blockedHead = blockedHeads.get(fixture.threadId);
      if (blockedHead === undefined) {
        throw new Error("Expected blocked head metadata");
      }
      const currentHead = await readChatEventSnapshotHead(
        context,
        fixture.threadId,
      );
      expect(currentHead).toStrictEqual(blockedHead);
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
    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const parentHead = await readChatEventSnapshotHead(context, threadId);

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-cas-tail-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);

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

    await Promise.all([
      runSnapshotCron([threadId]),
      runSnapshotCron([threadId]),
    ]);
    expect(arrivals).toBe(2);
    const head = await readChatEventSnapshotHead(context, threadId);
    expect(head.snapshot_count).toBe(parentHead.snapshot_count);
    expect(head.archive_schema_version).toBe(CURRENT_CHAT_EVENT_SCHEMA_VERSION);
    expect(head.last_seq_id).toBeGreaterThan(parentHead.last_seq_id);
    expect(head.object_key).not.toBe(parentHead.object_key);
  }, 90_000);
});
