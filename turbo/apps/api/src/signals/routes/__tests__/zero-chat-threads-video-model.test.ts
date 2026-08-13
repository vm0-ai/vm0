import { randomUUID } from "node:crypto";

import {
  chatThreadsContract,
  chatThreadVideoModelContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@okouai/api-contracts/contracts/composes";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { readChatThreadVideoModelFixture } from "../../../test-fixtures/chat-thread-events";
import { zeroChatThreadRoutes } from "../zero-chat-threads";
import { zeroChatThreadVideoModelRoutes } from "../zero-chat-threads-video-model";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const api = createRunsApi(context);

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
}

async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread video model agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
    model: "claude-sonnet-5",
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return { userId: actor.userId, orgId: actor.orgId, threadId: thread.id };
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function videoModelClient() {
  return setupApp({ context, routes: zeroChatThreadVideoModelRoutes })(
    chatThreadVideoModelContract,
  );
}

function threadsClient() {
  return setupApp({ context, routes: zeroChatThreadRoutes })(
    chatThreadsContract,
  );
}

async function readVideoModelEvents(token: string) {
  const response = await accept(
    threadsClient().events({
      headers: { authorization: `Bearer ${token}` },
      query: {},
    }),
    [200],
  );
  if (!("events" in response.body)) {
    throw new Error("Expected the event page");
  }
  return response.body.events.filter((event) => {
    return event.kind === "video_model_updated";
  });
}

describe("POST /api/okou/chat-threads/:id/video-model", () => {
  it("pins a video model and records one event", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "fal-ai/veo3.1/fast" },
      }),
      [204],
    );

    await expect(
      readChatThreadVideoModelFixture(fixture.threadId),
    ).resolves.toMatchObject({ selectedVideoModel: "fal-ai/veo3.1/fast" });
    const events = await readVideoModelEvents(token);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chatThreadId: fixture.threadId,
      selectedVideoModel: "fal-ai/veo3.1/fast",
    });
  });

  it("clears the pin so resolution falls through to the defaults", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "MiniMax-H3" },
      }),
      [204],
    );
    await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: null },
      }),
      [204],
    );

    await expect(
      readChatThreadVideoModelFixture(fixture.threadId),
    ).resolves.toMatchObject({ selectedVideoModel: null });
    await expect(readVideoModelEvents(token)).resolves.toHaveLength(2);
  });

  it("leaves the run model untouched", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "fal-ai/veo3.1/fast" },
      }),
      [204],
    );

    await expect(
      readChatThreadVideoModelFixture(fixture.threadId),
    ).resolves.toStrictEqual({
      selectedModel: "claude-sonnet-5",
      selectedVideoModel: "fal-ai/veo3.1/fast",
    });
  });

  it("reuses a caller-supplied event id so a retry appends once", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const eventId = randomUUID();

    for (const _attempt of [0, 1]) {
      await accept(
        videoModelClient().update({
          headers: { authorization: `Bearer ${token}` },
          params: { id: fixture.threadId },
          body: { model: "MiniMax-H3", eventId },
        }),
        [204],
      );
    }

    await expect(readVideoModelEvents(token)).resolves.toHaveLength(1);
  });

  it("rejects a model outside the catalog", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        // @ts-expect-error -- the contract rejects ids outside the catalog.
        body: { model: "claude-sonnet-5" },
      }),
      [400],
    );

    await expect(
      readChatThreadVideoModelFixture(fixture.threadId),
    ).resolves.toMatchObject({ selectedVideoModel: null });
  });

  it("returns 404 for a thread the caller does not own", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const other = await seedChatThread("Someone else's clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: other.threadId },
        body: { model: "MiniMax-H3" },
      }),
      [404],
    );

    await expect(
      readChatThreadVideoModelFixture(other.threadId),
    ).resolves.toMatchObject({ selectedVideoModel: null });
  });

  it("rejects a ZERO_TOKEN without chat-thread:write", async () => {
    const fixture = await seedChatThread("Product launch clip");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      videoModelClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { model: "MiniMax-H3" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-thread:write",
      },
    });
  });
});
