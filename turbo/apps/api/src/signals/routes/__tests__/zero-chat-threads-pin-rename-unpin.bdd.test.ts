import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadsContract,
  chatThreadUnpinContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface CreatedAgent extends Actor {
  readonly agentId: string;
}

interface CreatedThread extends CreatedAgent {
  readonly threadId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function chatThreadsClient() {
  return setupApp({ context })(chatThreadsContract);
}

function chatThreadByIdClient() {
  return setupApp({ context })(chatThreadByIdContract);
}

function pinClient() {
  return setupApp({ context })(chatThreadPinContract);
}

function unpinClient() {
  return setupApp({ context })(chatThreadUnpinContract);
}

function renameClient() {
  return setupApp({ context })(chatThreadRenameContract);
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    userId: `user_${prefix}_${suffix}`,
    orgId: `org_${prefix}_${suffix}`,
  };
}

function sameOrgUser(owner: Actor, prefix: string): Actor {
  return {
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
    orgId: owner.orgId,
  };
}

function clearRealtimeEvents(): void {
  context.mocks.ably.publish.mockClear();
}

function expectThreadListChangedOnce(): void {
  expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    "threadListChanged",
    null,
  );
}

function createChatThreadCleanupTracker(): {
  readonly trackAgent: (agent: CreatedAgent) => CreatedAgent;
  readonly trackThread: (thread: CreatedThread) => CreatedThread;
} {
  const trackedThreads: CreatedThread[] = [];
  const trackedAgents: CreatedAgent[] = [];

  afterEach(async () => {
    clearMockNow();
    while (trackedThreads.length > 0) {
      const thread = trackedThreads.pop();
      if (thread !== undefined) {
        await deleteThread(thread);
      }
    }
    while (trackedAgents.length > 0) {
      const agent = trackedAgents.pop();
      if (agent !== undefined) {
        await deleteAgent(agent);
      }
    }
  });

  return {
    trackAgent: (agent: CreatedAgent): CreatedAgent => {
      trackedAgents.push(agent);
      return agent;
    },
    trackThread: (thread: CreatedThread): CreatedThread => {
      trackedThreads.push(thread);
      return thread;
    },
  };
}

const { trackAgent, trackThread } = createChatThreadCleanupTracker();

async function createAgent(args: {
  readonly owner: Actor;
  readonly displayName: string;
}): Promise<CreatedAgent> {
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");
  context.mocks.s3.send.mockResolvedValue({});

  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: { displayName: args.displayName },
    }),
    [201],
  );

  const agent = { ...args.owner, agentId: response.body.agentId };
  return trackAgent(agent);
}

async function deleteAgent(agent: CreatedAgent): Promise<void> {
  mocks.clerk.session(agent.userId, agent.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      headers: authHeaders(),
      params: { id: agent.agentId },
    }),
    [204, 404],
  );
}

async function createThread(args: {
  readonly owner: Actor;
  readonly title: string;
}): Promise<CreatedThread> {
  const agent = await createAgent({
    owner: args.owner,
    displayName: `Chat Thread Agent ${randomUUID().slice(0, 8)}`,
  });
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");

  const response = await accept(
    chatThreadsClient().create({
      headers: authHeaders(),
      body: { agentId: agent.agentId, title: args.title },
    }),
    [201],
  );

  const thread = { ...agent, threadId: response.body.id };
  return trackThread(thread);
}

async function deleteThread(thread: CreatedThread): Promise<void> {
  mocks.clerk.session(thread.userId, thread.orgId, "org:admin");
  await accept(
    chatThreadByIdClient().delete({
      headers: authHeaders(),
      params: { id: thread.threadId },
    }),
    [204, 404],
  );
}

async function listThreads(args: Actor & { readonly agentId: string }) {
  mocks.clerk.session(args.userId, args.orgId, "org:admin");
  const response = await accept(
    chatThreadsClient().list({
      headers: authHeaders(),
      query: { agentId: args.agentId },
    }),
    [200],
  );
  return response.body;
}

async function getThread(thread: CreatedThread) {
  mocks.clerk.session(thread.userId, thread.orgId, "org:admin");
  const response = await accept(
    chatThreadByIdClient().get({
      headers: authHeaders(),
      params: { id: thread.threadId },
    }),
    [200],
  );
  return response.body;
}

describe("/api/zero/chat-threads pin, rename, and unpin BDD", () => {
  it("requires authentication before mutating thread metadata", async () => {
    const threadId = randomUUID();

    const pin = await accept(
      pinClient().pin({ headers: {}, params: { id: threadId } }),
      [401],
    );
    const unpin = await accept(
      unpinClient().unpin({ headers: {}, params: { id: threadId } }),
      [401],
    );
    const rename = await accept(
      renameClient().rename({
        headers: {},
        params: { id: threadId },
        body: { title: "Renamed" },
      }),
      [401],
    );

    expect(pin.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(unpin.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(rename.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 without realtime events for unknown thread ids", async () => {
    const caller = actor("unknown");
    mocks.clerk.session(caller.userId, caller.orgId, "org:admin");

    const pin = await accept(
      pinClient().pin({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [404],
    );
    const unpin = await accept(
      unpinClient().unpin({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [404],
    );
    const rename = await accept(
      renameClient().rename({
        headers: authHeaders(),
        params: { id: randomUUID() },
        body: { title: "Renamed" },
      }),
      [404],
    );

    expect(pin.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(unpin.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(rename.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("rejects an invalid rename body before mutating the thread", async () => {
    const owner = actor("invalid");
    const thread = await createThread({ owner, title: "Original" });
    clearRealtimeEvents();

    const response = await accept(
      renameClient().rename({
        headers: authHeaders(),
        params: { id: thread.threadId },
        body: { title: "" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("title");
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    const detail = await getThread(thread);
    expect(detail.title).toBe("Original");
    expect(detail.renamedAt).toBeNull();
  });

  it("pins, re-pins, renames, re-renames, and unpins through route-visible state", async () => {
    const owner = actor("owner");
    const thread = await createThread({ owner, title: "Original" });
    clearRealtimeEvents();

    const firstPinnedAt = "2026-06-10T10:00:00.000Z";
    mockNow(new Date(firstPinnedAt));
    await accept(
      pinClient().pin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [204],
    );

    let page = await listThreads(thread);
    let pinnedThread = page.pinned.find((item) => {
      return item.id === thread.threadId;
    });
    expect(page.threads).toHaveLength(0);
    expect(page.totalCount).toBe(0);
    expect(pinnedThread?.title).toBe("Original");
    expect(pinnedThread?.agent.id).toBe(thread.agentId);
    expect(pinnedThread?.pinnedAt).toBe(firstPinnedAt);
    expect(pinnedThread?.renamedAt).toBeNull();
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    const secondPinnedAt = "2026-06-10T10:05:00.000Z";
    mockNow(new Date(secondPinnedAt));
    await accept(
      pinClient().pin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [204],
    );

    page = await listThreads(thread);
    pinnedThread = page.pinned.find((item) => {
      return item.id === thread.threadId;
    });
    expect(pinnedThread?.pinnedAt).toBe(secondPinnedAt);
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    const firstRenamedAt = "2026-06-10T10:10:00.000Z";
    mockNow(new Date(firstRenamedAt));
    await accept(
      renameClient().rename({
        headers: authHeaders(),
        params: { id: thread.threadId },
        body: { title: "First rename" },
      }),
      [204],
    );

    let detail = await getThread(thread);
    expect(detail.title).toBe("First rename");
    expect(detail.renamedAt).toBe(firstRenamedAt);
    page = await listThreads(thread);
    pinnedThread = page.pinned.find((item) => {
      return item.id === thread.threadId;
    });
    expect(pinnedThread?.title).toBe("First rename");
    expect(pinnedThread?.renamedAt).toBe(firstRenamedAt);
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    const secondRenamedAt = "2026-06-10T10:15:00.000Z";
    mockNow(new Date(secondRenamedAt));
    await accept(
      renameClient().rename({
        headers: authHeaders(),
        params: { id: thread.threadId },
        body: { title: "Second rename" },
      }),
      [204],
    );

    detail = await getThread(thread);
    expect(detail.title).toBe("Second rename");
    expect(detail.renamedAt).toBe(secondRenamedAt);
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    await accept(
      unpinClient().unpin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [204],
    );

    page = await listThreads(thread);
    expect(page.pinned).toHaveLength(0);
    expect(page.threads).toHaveLength(1);
    expect(page.totalCount).toBe(1);
    expect(page.threads[0]).toMatchObject({
      id: thread.threadId,
      title: "Second rename",
      pinnedAt: null,
      renamedAt: secondRenamedAt,
    });
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    await accept(
      unpinClient().unpin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [204],
    );

    page = await listThreads(thread);
    expect(page.pinned).toHaveLength(0);
    expect(page.threads[0]?.pinnedAt).toBeNull();
    expect(page.threads[0]?.title).toBe("Second rename");
    expectThreadListChangedOnce();
  });

  it("returns 404 for another user without leaking or changing the thread", async () => {
    const owner = actor("owner");
    const thread = await createThread({ owner, title: "Owner original" });

    const ownerPinnedAt = "2026-06-10T11:00:00.000Z";
    mockNow(new Date(ownerPinnedAt));
    await accept(
      pinClient().pin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [204],
    );

    const ownerRenamedAt = "2026-06-10T11:05:00.000Z";
    mockNow(new Date(ownerRenamedAt));
    await accept(
      renameClient().rename({
        headers: authHeaders(),
        params: { id: thread.threadId },
        body: { title: "Owner title" },
      }),
      [204],
    );
    clearRealtimeEvents();

    const intruder = sameOrgUser(owner, "intruder");
    mocks.clerk.session(intruder.userId, intruder.orgId, "org:admin");

    const pin = await accept(
      pinClient().pin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [404],
    );
    const unpin = await accept(
      unpinClient().unpin({
        headers: authHeaders(),
        params: { id: thread.threadId },
      }),
      [404],
    );
    const rename = await accept(
      renameClient().rename({
        headers: authHeaders(),
        params: { id: thread.threadId },
        body: { title: "Hijacked" },
      }),
      [404],
    );

    expect(pin.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(unpin.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(rename.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    const intruderPage = await listThreads({
      ...intruder,
      agentId: thread.agentId,
    });
    expect(intruderPage.pinned).toHaveLength(0);
    expect(intruderPage.threads).toHaveLength(0);

    const ownerPage = await listThreads(thread);
    const ownerThread = ownerPage.pinned.find((item) => {
      return item.id === thread.threadId;
    });
    expect(ownerThread?.title).toBe("Owner title");
    expect(ownerThread?.pinnedAt).toBe(ownerPinnedAt);
    expect(ownerThread?.renamedAt).toBe(ownerRenamedAt);
  });
});
