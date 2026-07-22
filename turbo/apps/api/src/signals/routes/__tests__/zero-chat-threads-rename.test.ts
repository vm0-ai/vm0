import { randomUUID } from "node:crypto";

import {
  chatThreadMetadataContract,
  chatThreadRenameContract,
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
  readonly threadId: string;
}

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread rename agent",
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

function renameClient() {
  return setupApp({ context })(chatThreadRenameContract);
}

function metadataClient() {
  return setupApp({ context })(chatThreadMetadataContract);
}

describe("POST /api/zero/chat-threads/:id/rename", () => {
  it("renames a thread with ZERO_TOKEN chat-thread:write capability", async () => {
    const fixture = await seedChatThread("Original title");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:write"],
    });

    const response = await accept(
      renameClient().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "CLI renamed title" },
      }),
      [204],
    );
    expect(response.status).toBe(204);

    const metadataResponse = await accept(
      metadataClient().get({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["chat-thread:read"],
          })}`,
        },
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(metadataResponse.body).toStrictEqual({
      id: fixture.threadId,
      title: "CLI renamed title",
      selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    });
  });

  it("rejects ZERO_TOKEN without chat-thread:write capability", async () => {
    const fixture = await seedChatThread("Original title");
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-message:read"],
    });

    const response = await accept(
      renameClient().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "Unauthorized title" },
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
