import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadsContract,
  type PersistedAttachment,
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

function attachment(id: string): PersistedAttachment {
  return {
    id,
    url: `https://example.com/${id}.txt`,
    filename: `${id}.txt`,
    contentType: "text/plain",
    size: 100,
  };
}

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
  readonly owner: Actor;
  readonly title: string;
}): Promise<CreatedThread> {
  const agent = await createAgent({
    owner: args.owner,
    displayName: `Draft Agent ${randomUUID().slice(0, 8)}`,
  });
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");

  const response = await accept(
    chatThreadsClient().create({
      headers: authHeaders(),
      body: { agentId: agent.agentId, title: args.title },
    }),
    [201],
  );

  return trackThread({ ...agent, threadId: response.body.id });
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

async function patchThread(args: {
  readonly thread: CreatedThread;
  readonly draftContent?: string | null;
  readonly draftAttachments?: PersistedAttachment[] | null;
}): Promise<void> {
  mocks.clerk.session(args.thread.userId, args.thread.orgId, "org:admin");
  await accept(
    chatThreadByIdClient().patch({
      headers: authHeaders(),
      params: { id: args.thread.threadId },
      body: {
        draftContent: args.draftContent,
        draftAttachments: args.draftAttachments,
      },
    }),
    [204],
  );
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

describe("/api/zero/chat-threads patch BDD", () => {
  it("requires authentication before updating a draft", async () => {
    const response = await accept(
      chatThreadByIdClient().patch({
        params: { id: randomUUID() },
        body: { draftContent: "hello" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("rejects unknown and malformed thread ids without realtime events", async () => {
    const owner = actor("missing");
    const thread = await createThread({ owner, title: "Existing" });
    clearRealtimeEvents();

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const missing = await accept(
      chatThreadByIdClient().patch({
        params: { id: randomUUID() },
        body: { draftContent: "hello" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });

    const malformed = await accept(
      chatThreadByIdClient().patch({
        params: { id: "not-a-uuid" },
        body: { draftContent: "hello" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(malformed.body.error.code).toBe("BAD_REQUEST");
    expect(malformed.body.error.message).toContain("id");

    const detail = await getThread(thread);
    expect(detail.draftContent).toBeNull();
    expect(detail.draftAttachments).toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("updates, continues, and clears draft content through route-visible state", async () => {
    const owner = actor("draft");
    const thread = await createThread({ owner, title: "Draft lifecycle" });
    clearRealtimeEvents();

    await patchThread({ thread, draftContent: "first keystroke" });

    let detail = await getThread(thread);
    expect(detail.draftContent).toBe("first keystroke");
    expect(detail.draftAttachments).toBeNull();
    let page = await listThreads(thread);
    expect(page.threads[0]).toMatchObject({
      id: thread.threadId,
      hasDraft: true,
    });
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    await patchThread({ thread, draftContent: "continued typing" });

    detail = await getThread(thread);
    expect(detail.draftContent).toBe("continued typing");
    page = await listThreads(thread);
    expect(page.threads[0]?.hasDraft).toBeTruthy();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    clearRealtimeEvents();
    await patchThread({ thread, draftContent: null });

    detail = await getThread(thread);
    expect(detail.draftContent).toBeNull();
    expect(detail.draftAttachments).toBeNull();
    page = await listThreads(thread);
    expect(page.threads[0]?.hasDraft).toBeFalsy();
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    await patchThread({ thread, draftContent: null });

    detail = await getThread(thread);
    expect(detail.draftContent).toBeNull();
    page = await listThreads(thread);
    expect(page.threads[0]?.hasDraft).toBeFalsy();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("updates attachments and treats attachment-only drafts as list-visible drafts", async () => {
    const owner = actor("attachments");
    const thread = await createThread({ owner, title: "Draft attachments" });
    const attachments = [attachment("att-only")];
    clearRealtimeEvents();

    await patchThread({
      thread,
      draftContent: null,
      draftAttachments: attachments,
    });

    const detail = await getThread(thread);
    expect(detail.draftContent).toBeNull();
    expect(detail.draftAttachments).toStrictEqual(attachments);

    const page = await listThreads(thread);
    expect(page.threads[0]).toMatchObject({
      id: thread.threadId,
      hasDraft: true,
    });
    expectThreadListChangedOnce();
  });

  it("returns 404 for another user and preserves the owner draft", async () => {
    const owner = actor("owner");
    const thread = await createThread({ owner, title: "Owner draft" });
    await patchThread({ thread, draftContent: "owner content" });
    clearRealtimeEvents();

    const intruder = sameOrgUser(owner, "intruder");
    mocks.clerk.session(intruder.userId, intruder.orgId, "org:admin");
    const response = await accept(
      chatThreadByIdClient().patch({
        params: { id: thread.threadId },
        body: { draftContent: "unauthorized" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    const intruderPage = await listThreads({
      ...intruder,
      agentId: thread.agentId,
    });
    expect(intruderPage.threads).toHaveLength(0);

    const detail = await getThread(thread);
    expect(detail.draftContent).toBe("owner content");
  });
});
