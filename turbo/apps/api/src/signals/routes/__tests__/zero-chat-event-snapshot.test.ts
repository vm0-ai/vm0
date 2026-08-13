import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { chatEventFromRow } from "@vm0/api-contracts/contracts/chat-event-row-projection";
import { chatEventRowV4Schema } from "@vm0/api-contracts/contracts/chat-event-rows";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  cronProjectChatEventSearchContract,
  cronSnapshotChatEventsContract,
} from "@vm0/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { zeroChatThreadRoutes } from "../zero-chat-threads";
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
import {
  readChatEventSnapshotHead,
  setChatEventSnapshotHeadVersion,
} from "./helpers/runtime-state";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
// Manual objects share the fake R2 directory, so each test owns its teardown.
const trackFakeChatEventObject = createFixtureTracker(
  deleteFakeChatEventObject,
);

const CRON_SECRET = "test-cron-secret";
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
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function eventsClient() {
  return setupApp({ context, routes: zeroChatThreadRoutes })(
    chatThreadEventsContract,
  );
}

async function runSnapshotCron() {
  const client = setupApp({ context, routes: cronSnapshotChatEventsRoutes })(
    cronSnapshotChatEventsContract,
  );
  const response = await accept(
    client.snapshot({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
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

async function replaceHeadWithRetiredVersion(
  threadId: string,
): Promise<string> {
  const head = await readChatEventSnapshotHead(context, threadId);
  const body = readFakeChatEventObject(head.object_key);
  if (body === undefined) {
    throw new Error("Expected a current snapshot object");
  }
  const retiredKey = `chat-events/${threadId}/retired-v3-${randomUUID()}.ndjson.gz`;
  writeFakeChatEventObject(retiredKey, body);
  await trackFakeChatEventObject(Promise.resolve(retiredKey));
  await setChatEventSnapshotHeadVersion(context, threadId, 3, retiredKey);
  return retiredKey;
}

describe("chat event snapshot read endpoints", () => {
  beforeEach(() => {
    installFakeChatEventR2(context);
    // Drain every candidate thread in the shared test database in one pass so
    // assertions about this file's threads never depend on batch ordering.
    mockOptionalEnv("CHAT_EVENT_SNAPSHOT_BATCH_SIZE", "10000");
    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "10000");
  });

  it("serves a presigned download only for a current-version head", async () => {
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

    await projectChatEventSearch();
    await runSnapshotCron();
    const head = await readChatEventSnapshotHead(context, threadId);

    const download = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    expect(download.body).toStrictEqual({
      url: FAKE_CHAT_EVENT_SNAPSHOT_URL,
      expiresInSeconds: 900,
      lastSeqId: head.last_seq_id,
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
        return chatEventFromRow(chatEventRowV4Schema.parse(JSON.parse(line)));
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

    // Unsupported heads fail closed instead of entering a rewrite fallback.
    await setChatEventSnapshotHeadVersion(context, threadId, 2);
    await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [404],
    );
    // The snapshot cron scope is global, so an unsupported head left behind
    // would fail every later pass in the suite.
    await setChatEventSnapshotHeadVersion(context, threadId, 5);

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

  it("serves projectable raw rows from sequence cursors", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Row parity agent",
    });
    const marker = `row-parity-${randomUUID()}`;
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} first`,
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
    const firstSeqId = fromStart.body.rows[0]?.seqId;
    if (firstSeqId === undefined) {
      throw new Error("Expected seeded chat events");
    }

    const rows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: { sinceSeqId: firstSeqId },
      }),
      [200],
    );
    for (const row of rows.body.rows) {
      chatEventRowV4Schema.parse(row);
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

    const expired = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: { sinceSeqId: 999_999 },
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

  it("lists the authoritative queue without requiring a snapshot", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    await api.grantProEntitlement(owner);
    await api.ensureOrgModelProvider(owner);
    api.configureRunnerGroup();
    const agent = await bdd.createAgent(owner, {
      displayName: "Authoritative queue agent",
    });
    const active = await chat.requestSendEvent(
      owner,
      {
        agentId: agent.agentId,
        prompt: `authoritative-queue-blocker-${randomUUID()}`,
      },
      [201],
    );
    if (active.status !== 201 || active.body.runId === null) {
      throw new Error("Expected an active blocker run");
    }
    const queuedEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      owner,
      {
        agentId: agent.agentId,
        threadId: active.body.threadId,
        clientEventId: queuedEventId,
        prompt: `authoritative-queue-pending-${randomUUID()}`,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the second message to be queued");
    }
    expect(queued.body.runId).toBeNull();
    const threadId = active.body.threadId;

    const response = await accept(
      eventsClient().queued({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    expect(response.body.events).toStrictEqual([
      { eventId: queuedEventId, seqId: expect.any(Number) },
    ]);
    await api.requestCancelRun(owner, active.body.runId, [200]);
  }, 60_000);

  it("immediately retires snapshot versions below the supported minimum", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot version retirement agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-version-retirement-${randomUUID()}`,
    });

    await projectChatEventSearch();
    await runSnapshotCron();
    const retiredKey = await replaceHeadWithRetiredVersion(threadId);

    const retired = await runSnapshotCron();
    expect(retired.retiredSnapshotReferencesDeleted).toBeGreaterThanOrEqual(1);
    expect(readFakeChatEventObject(retiredKey)).toBeUndefined();
    const current = await readChatEventSnapshotHead(context, threadId);
    expect(current).toMatchObject({
      archive_schema_version: 5,
      snapshot_count: 1,
    });
  }, 60_000);

  it("keeps database retirement successful when R2 deletion fails", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot best-effort cleanup agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-best-effort-${randomUUID()}`,
    });

    await projectChatEventSearch();
    await runSnapshotCron();
    const retiredKey = await replaceHeadWithRetiredVersion(threadId);
    installFakeChatEventR2(context, undefined, undefined, () => {
      return Promise.reject(new Error("R2 delete unavailable"));
    });

    const retired = await runSnapshotCron();
    expect(retired.retiredSnapshotReferencesDeleted).toBeGreaterThanOrEqual(1);
    expect(readFakeChatEventObject(retiredKey)).toBeDefined();
    const current = await readChatEventSnapshotHead(context, threadId);
    expect(current).toMatchObject({
      archive_schema_version: 5,
      snapshot_count: 1,
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

    await projectChatEventSearch();
    // The cron scope is global, so only this thread's own head is asserted.
    await runSnapshotCron();

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
    const protectedHead = await runSnapshotCron();
    expect(protectedHead.r2ObjectsDeleted).toBe(0);
    expect(readFakeChatEventObject(head.object_key)).toBeDefined();

    const orphanKey = `chat-events/${threadId.slice(0, 3)}-orphan.ndjson.gz`;
    writeFakeChatEventObject(orphanKey, Buffer.from("orphan"));
    await trackFakeChatEventObject(Promise.resolve(orphanKey));
    ageFakeChatEventObject(
      orphanKey,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const orphanGc = await runSnapshotCron();
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
    await projectChatEventSearch();
    const replacement = await runSnapshotCron();
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

    const result = await runSnapshotCron();

    expect(
      result.retiredSnapshotReferencesDeleted + result.r2ObjectsDeleted,
    ).toBe(1000);
    const remaining = keys.filter((key) => {
      return readFakeChatEventObject(key) !== undefined;
    });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
