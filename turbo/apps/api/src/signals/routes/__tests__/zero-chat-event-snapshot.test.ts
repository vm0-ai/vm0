import { randomUUID } from "node:crypto";

import {
  goalRunIdsFromChatEventRows,
  chatEventFromRow,
} from "@vm0/api-contracts/contracts/chat-event-row-projection";
import { chatEventRowSchema } from "@vm0/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
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
import { zeroChatThreadRoutes } from "../zero-chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  FAKE_CHAT_EVENT_SNAPSHOT_URL,
  installFakeChatEventR2,
} from "./helpers/fake-chat-event-r2";
import {
  readChatEventSnapshotHead,
  setChatEventSnapshotHeadAsV1,
} from "./helpers/runtime-state";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);

const CRON_SECRET = "test-cron-secret";

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

async function runSnapshotCron(): Promise<void> {
  const client = setupApp({ context, routes: cronSnapshotChatEventsRoutes })(
    cronSnapshotChatEventsContract,
  );
  await accept(
    client.snapshot({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
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

    // Older heads behave as missing until the archiver rewrites them.
    await setChatEventSnapshotHeadAsV1(context, threadId, head.object_key);
    await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [404],
    );

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

  it("serves raw rows whose projection matches the events endpoint", async () => {
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

    const events = await accept(
      eventsClient().list({
        headers: authenticate(owner),
        params: { threadId },
        query: {},
      }),
      [200],
    );
    const firstSeqId = events.body.events[0]?.seqId;
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
      chatEventRowSchema.parse(row);
      expect(row.chatThreadId).toBe(threadId);
    }

    const goalRunIds = goalRunIdsFromChatEventRows(rows.body.rows);
    const projected = rows.body.rows.map((row) => {
      return chatEventFromRow(row, goalRunIds);
    });
    const expected = events.body.events.filter((event) => {
      return event.seqId > firstSeqId;
    });
    // Compare wire shapes: drop the projection's explicit-undefined optional
    // keys the same way JSON serialization does for the HTTP response.
    const wireShape = projected.map((event) => {
      return Object.fromEntries(
        Object.entries(event).filter(([, value]) => {
          return value !== undefined;
        }),
      );
    });
    expect(wireShape).toStrictEqual(expected);

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
});
