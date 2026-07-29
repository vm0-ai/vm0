import { randomUUID } from "node:crypto";

import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@vm0/api-contracts/contracts/model-providers";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread metadata agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
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

function client() {
  return setupApp({ context })(chatThreadMetadataContract);
}

function eventsClient() {
  return setupApp({ context })(chatThreadEventsContract);
}

describe("GET /api/zero/chat-threads/:id/metadata", () => {
  it("returns thread metadata with ZERO_TOKEN chat-thread:read capability", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      client().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: fixture.threadId,
      agentId: fixture.agentId,
      title: "Launch plan",
      selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    });
  });

  it("rejects ZERO_TOKEN without chat-thread:read capability", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:write"],
    });

    const response = await accept(
      client().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-thread:read",
      },
    });
  });
});

describe("GET /api/zero/chat-threads/:threadId/events", () => {
  it("lists events with ZERO_TOKEN chat-message:read capability", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-message:read"],
    });

    const response = await accept(
      eventsClient().list({
        headers: { authorization: `Bearer ${token}` },
        params: { threadId: fixture.threadId },
        query: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      events: [],
      hasHistoryBefore: false,
    });
  });

  it("rejects ZERO_TOKEN without chat-message:read capability", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      eventsClient().list({
        headers: { authorization: `Bearer ${token}` },
        params: { threadId: fixture.threadId },
        query: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-message:read",
      },
    });
  });
});
