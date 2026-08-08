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
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  installFakeChatEventR2,
  writeFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import {
  readChatEventSnapshotHead,
  setChatEventSnapshotHeadVersion,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);

const CRON_SECRET = "test-cron-secret";
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
  expect(put.contentType).toBe("application/x-ndjson");
  expect(put.contentEncoding).toBe("gzip");
  expect(match?.[3]).toBe(createHash("sha256").update(put.body).digest("hex"));

  const lines = archivedLines(put.body);
  expect(lines.length).toBeGreaterThan(0);
  const lastLine = lines[lines.length - 1];
  expect(String(lastLine?.seqId)).toBe(match?.[2]);
  for (const [index, line] of lines.entries()) {
    expect(Object.keys(line).sort()).toStrictEqual(ARCHIVE_V2_KEYS);
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
    expect(firstHead.archive_schema_version).toBe(3);
    expect(firstHead.object_key).toBe(firstPut.key);

    // Nothing new to archive: the same pass again must not touch the thread.
    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(1);

    // A new Postgres tail beyond the projected watermark triggers a rebuild
    // that verifies the canonical parent and appends only the new tail rows.
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
    expect(secondHead.archive_schema_version).toBe(3);
    expect(secondHead.object_key).toBe(secondPut.key);

    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);

  it("fails the pass when a head carries an unsupported schema version", async () => {
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
    await setChatEventSnapshotHeadVersion(context, threadId, 2);

    // An idle head on a retired version is never a candidate, so it cannot
    // strand the globally scoped pass for every other thread.
    const idle = await runSnapshotCron();
    expect(idle.success).toBeTruthy();
    expect(putsForThread(threadId)).toHaveLength(1);
    const idleHead = await readChatEventSnapshotHead(context, threadId);
    expect(idleHead.archive_schema_version).toBe(2);
    expect(idleHead.object_key).toBe(firstPut.key);

    // With a new tail the thread is a candidate again, and the retired rewrite
    // fallback means it fails closed instead of republishing under v3.
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `version-only-tail-${randomUUID()}`,
    });
    await projectChatEventSearch();
    await accept(
      snapshotCronClient().snapshot({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [500],
    );
    expect(putsForThread(threadId)).toHaveLength(1);
    const strandedHead = await readChatEventSnapshotHead(context, threadId);
    expect(strandedHead.archive_schema_version).toBe(2);
    expect(strandedHead.object_key).toBe(firstPut.key);

    // Restore the supported version: the cron scope is global, so an
    // unsupported head left behind would fail every later pass in the suite.
    await setChatEventSnapshotHeadVersion(context, threadId, 3);
    const recovered = await runSnapshotCron();
    expect(recovered.success).toBeTruthy();
    const recoveredHead = await readChatEventSnapshotHead(context, threadId);
    expect(recoveredHead.last_seq_id).toBeGreaterThan(firstHead.last_seq_id);
    expect(recoveredHead.object_key).not.toBe(firstPut.key);
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
    writeFakeChatEventObject(headPut.key, corrupted);

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
    writeFakeChatEventObject(headPut.key, headPut.body);
    await runSnapshotCron();
    expect(putsForThread(threadId)).toHaveLength(2);
  }, 60_000);
});
