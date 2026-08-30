import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  ageFakeChatEventObject,
  deleteFakeChatEventObject,
  FAKE_CHAT_EVENT_SNAPSHOT_URL,
  installFakeChatEventR2,
  readFakeChatEventObject,
  writeFakeChatEventObject,
} from "./helpers/fake-chat-event-r2";
import { readChatEventSnapshotHead } from "./helpers/runtime-state";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
// Manual objects share the fake R2 directory, so each test owns its teardown.
const trackFakeChatEventObject = createFixtureTracker(
  deleteFakeChatEventObject,
);

const R2_GC_SLOT_MS = 10 * 60 * 1000;
const R2_GC_SHARD_GROUP_COUNT = 16 ** 2;

function mockR2GcWindowForKey(key: string, after: Date): Date {
  const prefixStart = "chat-events/".length;
  const shardGroup = Number.parseInt(
    key.slice(prefixStart, prefixStart + 2),
    16,
  );
  const firstSlot = Math.ceil(after.getTime() / R2_GC_SLOT_MS);
  const slotOffset =
    (shardGroup -
      (firstSlot % R2_GC_SHARD_GROUP_COUNT) +
      R2_GC_SHARD_GROUP_COUNT) %
    R2_GC_SHARD_GROUP_COUNT;
  const aligned = new Date((firstSlot + slotOffset) * R2_GC_SLOT_MS);
  mockNow(aligned);
  return aligned;
}

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return {
    authorization: "Bearer clerk-session",
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
  };
}

function eventsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadEventsContract,
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

async function projectChatEventSearch(
  ...chatThreadIds: readonly string[]
): Promise<void> {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
    readonly userMessage?: UserMessageDocument;
  },
): Promise<string> {
  await api.ensureOrgModelProvider(actor);
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected a no-credit send without a run");
  }
  return sent.body.threadId;
}

describe("chat event snapshot read endpoints", () => {
  beforeEach(() => {
    installFakeChatEventR2(context);
  });

  it("serves the current Snapshot version and its terminal cursor", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot download agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-download-${randomUUID()}`,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "Snapshot feedback quote",
            note: [{ type: "text", text: "Keep the canonical location." }],
            eventId: "snapshot-feedback-source-event",
            range: { start: 4, end: 13 },
          },
        ],
      },
    });

    const missing = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const head = await readChatEventSnapshotHead(context, threadId);

    const download = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    expect(download.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    );
    expect(download.body).toStrictEqual({
      url: FAKE_CHAT_EVENT_SNAPSHOT_URL,
      expiresInSeconds: 900,
      lastEventId: head.last_event_id,
      lastSeqId: head.last_seq_id,
      projection: "tool-redacted",
    });

    const snapshotObject = readFakeChatEventObject(head.object_key);
    if (snapshotObject === undefined) {
      throw new Error("Expected the feedback snapshot object");
    }
    const archivedEvents = gunzipSync(snapshotObject)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        return chatEventFromRow(chatEventRowSchema.parse(JSON.parse(line)));
      });
    const archivedInput = archivedEvents.find((event) => {
      return event.eventType === "input.prompt";
    });
    if (archivedInput?.eventType !== "input.prompt") {
      throw new Error("Expected the archived feedback input");
    }
    const archivedFeedback = archivedInput.userMessage.parts.find((part) => {
      return part.type === "feedback";
    });
    expect(archivedFeedback).toStrictEqual({
      type: "feedback",
      quote: "Snapshot feedback quote",
      note: [{ type: "text", text: "Keep the canonical location." }],
      eventId: "snapshot-feedback-source-event",
      range: { start: 4, end: 13 },
    });

    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toMatchObject({
      archive_schema_version: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      last_event_id: head.last_event_id,
      last_seq_id: head.last_seq_id,
      object_key: head.object_key,
      snapshot_count: 1,
    });

    const stranger = bdd.user({ orgId: `org_${randomUUID()}` });
    const strangerResponse = await accept(
      eventsClient().snapshot({
        headers: authenticate(stranger),
        params: { threadId },
      }),
      [404],
    );
    expect(strangerResponse.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  }, 60_000);

  it("applies the same schema-version errors to Snapshot and Raw Event reads", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Schema negotiation agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `schema-negotiation-${randomUUID()}`,
    });
    const { authorization } = authenticate(owner);
    const rawRequest = setupRawAppRequest({
      context,
      routes: chatThreadRoutes,
    });
    const missingVersionPaths = [
      `/api/okou/chat-threads/${threadId}/event-snapshot`,
      `/api/okou/chat-threads/${threadId}/event-rows?sinceSeqId=0`,
    ];
    for (const path of missingVersionPaths) {
      const response = await rawRequest(path, {
        method: "GET",
        headers: { authorization },
      });
      expect(response).toStrictEqual({
        status: 400,
        body: {
          error: {
            message: "Invalid Chat Event schema version",
            code: "CHAT_EVENT_SCHEMA_VERSION_INVALID",
          },
        },
      });
    }
    const request = async (endpoint: "snapshot" | "rows", version: string) => {
      const headers = {
        ...authenticate(owner),
        [CHAT_EVENT_SCHEMA_VERSION_HEADER]: version,
      };
      return endpoint === "snapshot"
        ? await eventsClient().snapshot({ headers, params: { threadId } })
        : await eventsClient().rows({
            headers,
            params: { threadId },
            query: { sinceSeqId: 0 },
          });
    };
    const cases = [
      {
        version: "invalid",
        status: 400,
        message: "Invalid Chat Event schema version",
        code: "CHAT_EVENT_SCHEMA_VERSION_INVALID",
      },
      {
        version: (CURRENT_CHAT_EVENT_SCHEMA_VERSION - 1).toString(),
        status: 426,
        message: "The requested Chat Event schema version is retired",
        code: "CHAT_EVENT_SCHEMA_VERSION_RETIRED",
      },
      {
        version: (CURRENT_CHAT_EVENT_SCHEMA_VERSION + 1).toString(),
        status: 409,
        message:
          "The requested Chat Event schema version is newer than this API",
        code: "CHAT_EVENT_SCHEMA_VERSION_AHEAD",
      },
    ] as const;

    for (const endpoint of ["snapshot", "rows"] as const) {
      for (const testCase of cases) {
        const response = await request(endpoint, testCase.version);
        expect(response.status).toBe(testCase.status);
        expect(response.body).toStrictEqual({
          error: { message: testCase.message, code: testCase.code },
        });
      }
    }
  }, 60_000);

  it("serves current Raw Event rows from cold-start and paired cursors", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Row parity agent",
    });
    const marker = `row-parity-${randomUUID()}`;
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} first`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: `${marker} first` },
          {
            type: "feedback",
            quote: "Raw feedback quote",
            note: [{ type: "text", text: "Keep the Raw Event location." }],
            eventId: "raw-feedback-source-event",
            range: { start: 2, end: 8 },
          },
        ],
      },
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} second`,
    });

    const fromStart = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    expect(fromStart.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    );
    const firstRow = fromStart.body.rows[0];
    if (firstRow === undefined) {
      throw new Error("Expected seeded chat events");
    }
    const firstSeqId = firstRow.seqId;

    const canonicalInput = fromStart.body.rows
      .map((row) => {
        return chatEventFromRow(row);
      })
      .find((event) => {
        return event.eventType === "input.prompt";
      });
    if (canonicalInput?.eventType !== "input.prompt") {
      throw new Error("Expected the canonical feedback input");
    }
    expect(
      canonicalInput.userMessage.parts.find((part) => {
        return part.type === "feedback";
      }),
    ).toMatchObject({
      type: "feedback",
      eventId: "raw-feedback-source-event",
      range: { start: 2, end: 8 },
    });

    const rows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: firstRow.id,
        },
      }),
      [200],
    );
    expect(rows.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    );
    expect(rows.body.projection).toBe("tool-redacted");
    expect(rows.body.cursor).toMatchObject({
      projection: "tool-redacted",
    });
    for (const row of rows.body.rows) {
      chatEventRowSchema.parse(row);
      expect(row.chatThreadId).toBe(threadId);
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("userMessage");
      expect(row).not.toHaveProperty("usagePayload");
      expect(row).not.toHaveProperty("interruptsRunId");
      expect(row).not.toHaveProperty("runGroupId");
    }

    const projected = rows.body.rows.map((row) => {
      return chatEventFromRow(row);
    });
    expect(projected).toHaveLength(rows.body.rows.length);
    expect(rows.body.rows).toStrictEqual(
      fromStart.body.rows.filter((row) => {
        return row.seqId > firstSeqId;
      }),
    );
    expect(projected).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: `${marker} second`,
              }),
            ]),
          }),
        }),
      ]),
    );

    expect(fromStart.body.rows[0]?.seqId).toBe(firstSeqId);
    expect(fromStart.body.rows).toHaveLength(rows.body.rows.length + 1);

    const mismatchedPair = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: randomUUID(),
          sinceProjection: "tool-redacted",
        },
      }),
      [410],
    );
    expect(mismatchedPair.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });

    const expired = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: 999_999,
          sinceEventId: randomUUID(),
          sinceProjection: "tool-redacted",
        },
      }),
      [410],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });
  }, 60_000);

  it("garbage-collects unreferenced snapshot objects", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot maintenance agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-maintenance-${randomUUID()}`,
    });

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);

    const head = await readChatEventSnapshotHead(context, threadId);
    expect(readFakeChatEventObject(head.object_key)).toBeDefined();

    const future = mockR2GcWindowForKey(
      head.object_key,
      new Date(now() + 8 * 24 * 60 * 60 * 1000),
    );
    ageFakeChatEventObject(
      head.object_key,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const protectedHead = await runSnapshotCron([threadId], [head.object_key]);
    expect(protectedHead.r2ObjectsDeleted).toBe(0);
    expect(readFakeChatEventObject(head.object_key)).toBeDefined();

    const orphanKey = `chat-events/${threadId.slice(0, 3)}-orphan.ndjson.gz`;
    writeFakeChatEventObject(orphanKey, Buffer.from("orphan"));
    await trackFakeChatEventObject(Promise.resolve(orphanKey));
    ageFakeChatEventObject(
      orphanKey,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const orphanGc = await runSnapshotCron([threadId], [orphanKey]);
    expect(orphanGc).toMatchObject({
      r2ObjectsMeasured: 1,
      r2ObjectsDeleted: 1,
    });
    expect(readFakeChatEventObject(orphanKey)).toBeUndefined();

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-replacement-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    const replacement = await runSnapshotCron([threadId], [head.object_key]);
    expect(replacement.r2ObjectsDeleted).toBe(1);
    expect(readFakeChatEventObject(head.object_key)).toBeUndefined();
    const newHead = await readChatEventSnapshotHead(context, threadId);
    expect(newHead.object_key).not.toBe(head.object_key);
    expect(readFakeChatEventObject(newHead.object_key)).toBeDefined();
  }, 120_000);

  it("limits object cleanup to the fixed per-pass quota", async () => {
    const shard = "ffe";
    const marker = randomUUID();
    const keys = Array.from({ length: 1001 }, (_, index) => {
      const subpartition = (index % 16).toString(16);
      return `chat-events/${shard}${subpartition}-quota-${marker}-${index.toString().padStart(4, "0")}.ndjson.gz`;
    });
    for (const key of keys) {
      writeFakeChatEventObject(key, Buffer.from("orphan"));
      await trackFakeChatEventObject(Promise.resolve(key));
    }
    mockR2GcWindowForKey(
      `chat-events/${shard}`,
      new Date(now() + 8 * 24 * 60 * 60 * 1000),
    );

    const result = await runSnapshotCron([], keys);

    expect(result.r2ObjectsDeleted).toBe(1000);
    const remaining = keys.filter((key) => {
      return readFakeChatEventObject(key) !== undefined;
    });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
