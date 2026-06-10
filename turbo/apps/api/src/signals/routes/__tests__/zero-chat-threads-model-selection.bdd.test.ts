import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const selectedModel = "claude-sonnet-4-6";

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

function modelSelectionClient() {
  return setupApp({ context })(chatThreadModelSelectionContract);
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

function modelFirstSelection(model: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel: model,
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
  readonly owner: Actor;
  readonly title: string;
}): Promise<CreatedThread> {
  const agent = await createAgent({
    owner: args.owner,
    displayName: `Model Selection Agent ${randomUUID().slice(0, 8)}`,
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

async function updateModelSelection(args: {
  readonly thread: CreatedThread;
  readonly modelSelection: ReturnType<typeof modelFirstSelection> | null;
}): Promise<void> {
  mocks.clerk.session(args.thread.userId, args.thread.orgId, "org:admin");
  await accept(
    modelSelectionClient().update({
      headers: authHeaders(),
      params: { id: args.thread.threadId },
      body: { modelSelection: args.modelSelection },
    }),
    [204],
  );
}

describe("/api/zero/chat-threads model selection BDD", () => {
  it("requires authentication before updating model selection", async () => {
    const response = await accept(
      modelSelectionClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: { modelSelection: modelFirstSelection(selectedModel) },
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
      modelSelectionClient().update({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: { modelSelection: modelFirstSelection(selectedModel) },
      }),
      [404],
    );
    expect(missing.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const malformed = await accept(
      modelSelectionClient().update({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
        body: { modelSelection: modelFirstSelection(selectedModel) },
      }),
      [400],
    );
    expect(malformed.body.error.code).toBe("BAD_REQUEST");
    expect(malformed.body.error.message).toContain("id");

    const detail = await getThread(thread);
    expect(detail.selectedModel).toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("updates and clears model selection through route-visible state", async () => {
    const owner = actor("model");
    const thread = await createThread({ owner, title: "Model override" });
    clearRealtimeEvents();

    await updateModelSelection({
      thread,
      modelSelection: modelFirstSelection(selectedModel),
    });

    let detail = await getThread(thread);
    expect(detail.selectedModel).toBe(selectedModel);
    expectThreadListChangedOnce();

    clearRealtimeEvents();
    await updateModelSelection({ thread, modelSelection: null });

    detail = await getThread(thread);
    expect(detail.modelProviderId).toBeNull();
    expect(detail.modelProviderType).toBeNull();
    expect(detail.modelProviderCredentialScope).toBeNull();
    expect(detail.selectedModel).toBeNull();
    expectThreadListChangedOnce();
  });

  it("returns 404 for another user and preserves the owner model selection", async () => {
    const owner = actor("owner");
    const thread = await createThread({ owner, title: "Owner model" });
    await updateModelSelection({
      thread,
      modelSelection: modelFirstSelection(selectedModel),
    });
    clearRealtimeEvents();

    const intruder = sameOrgUser(owner, "intruder");
    mocks.clerk.session(intruder.userId, intruder.orgId, "org:admin");
    const response = await accept(
      modelSelectionClient().update({
        params: { id: thread.threadId },
        headers: authHeaders(),
        body: { modelSelection: null },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    const detail = await getThread(thread);
    expect(detail.selectedModel).toBe(selectedModel);
  });

  it("rejects invalid model-first selections without changing the thread", async () => {
    const owner = actor("invalid");
    const thread = await createThread({ owner, title: "Invalid model" });
    clearRealtimeEvents();

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const response = await accept(
      modelSelectionClient().update({
        params: { id: thread.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: modelFirstSelection("not-a-supported-model"),
        },
      }),
      [400],
    );

    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    const detail = await getThread(thread);
    expect(detail.selectedModel).toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
