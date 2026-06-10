import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    userId: `user_${prefix}_${suffix}`,
    orgId: `org_${prefix}_${suffix}`,
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

  return trackAgent({ ...args.owner, agentId: response.body.agentId });
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
  readonly agent: CreatedAgent;
  readonly title?: string;
  readonly clientThreadId?: string;
}): Promise<CreatedThread> {
  mocks.clerk.session(args.agent.userId, args.agent.orgId, "org:admin");
  const response = await accept(
    chatThreadsClient().create({
      headers: authHeaders(),
      body: {
        agentId: args.agent.agentId,
        title: args.title,
        clientThreadId: args.clientThreadId,
      },
    }),
    [201],
  );

  return trackThread({ ...args.agent, threadId: response.body.id });
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

describe("/api/zero/chat-threads create BDD", () => {
  it("requires authentication before creating a thread", async () => {
    const response = await accept(
      chatThreadsClient().create({
        headers: {},
        body: { agentId: randomUUID(), title: "x" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("creates a thread and exposes it through detail and list APIs", async () => {
    const owner = actor("owner");
    const agent = await createAgent({
      owner,
      displayName: "Thread Creator",
    });
    clearRealtimeEvents();

    const thread = await createThread({ agent, title: "My thread" });

    const detail = await getThread(thread);
    expect(detail).toMatchObject({
      id: thread.threadId,
      agentId: agent.agentId,
      title: "My thread",
    });
    expect(detail.createdAt).toBeDefined();

    const page = await listThreads(agent);
    expect(page.pinned).toHaveLength(0);
    expect(page.threads).toHaveLength(1);
    expect(page.totalCount).toBe(1);
    expect(page.threads[0]).toMatchObject({
      id: thread.threadId,
      title: "My thread",
      agent: { id: agent.agentId },
    });
    expectThreadListChangedOnce();
  });

  it("uses the caller supplied clientThreadId and null title", async () => {
    const owner = actor("client");
    const agent = await createAgent({
      owner,
      displayName: "Client Thread Agent",
    });
    const clientThreadId = randomUUID();
    clearRealtimeEvents();

    const thread = await createThread({ agent, clientThreadId });

    expect(thread.threadId).toBe(clientThreadId);
    const detail = await getThread(thread);
    expect(detail).toMatchObject({
      id: clientThreadId,
      agentId: agent.agentId,
      title: null,
    });

    const page = await listThreads(agent);
    expect(page.threads[0]).toMatchObject({
      id: clientThreadId,
      title: null,
    });
    expectThreadListChangedOnce();
  });

  it("returns 404 without creating a thread when the agent is not visible", async () => {
    const owner = actor("owner");
    const ownerAgent = await createAgent({
      owner,
      displayName: "Owner Agent",
    });
    const otherOwner = actor("other");
    const otherAgent = await createAgent({
      owner: otherOwner,
      displayName: "Other Agent",
    });
    clearRealtimeEvents();

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const crossOrg = await accept(
      chatThreadsClient().create({
        headers: authHeaders(),
        body: { agentId: otherAgent.agentId, title: "Hijacked" },
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    const missing = await accept(
      chatThreadsClient().create({
        headers: authHeaders(),
        body: { agentId: randomUUID(), title: "Missing" },
      }),
      [404],
    );
    expect(missing.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    mocks.clerk.session(`user_no_org_${randomUUID().slice(0, 8)}`, null);
    const noOrg = await accept(
      chatThreadsClient().create({
        headers: authHeaders(),
        body: { agentId: ownerAgent.agentId, title: "No org" },
      }),
      [404],
    );
    expect(noOrg.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    const ownerPage = await listThreads(ownerAgent);
    expect(ownerPage.threads).toHaveLength(0);
    const otherPage = await listThreads(otherAgent);
    expect(otherPage.threads).toHaveLength(0);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
