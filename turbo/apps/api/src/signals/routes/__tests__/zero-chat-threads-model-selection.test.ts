import { randomUUID } from "node:crypto";

import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";

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

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    {
      model: "claude-sonnet-5",
      isDefault: false,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread model selection agent",
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
  return { userId: actor.userId, orgId: actor.orgId, threadId: thread.id };
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

function modelSelectionClient() {
  return setupApp({ context })(chatThreadModelSelectionContract);
}

function metadataClient() {
  return setupApp({ context })(chatThreadMetadataContract);
}

describe("POST /api/zero/chat-threads/:id/model-selection", () => {
  it("updates thread model selection with ZERO_TOKEN chat-thread:write capability", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          model: "claude-sonnet-5",
        },
      }),
      [204],
    );

    const response = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: fixture.threadId,
      title: "Launch plan",
      selectedModel: "claude-sonnet-5",
    });
  });

  it("rejects ZERO_TOKEN without chat-thread:write capability", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          model: "claude-sonnet-5",
        },
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
