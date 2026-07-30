import { randomUUID } from "node:crypto";

import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);

const WORKSPACE_DEFAULT_MODEL = "claude-sonnet-4-6";
const OTHER_WORKSPACE_MODEL = "claude-sonnet-5";

interface AgentFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

/** Creates an agent whose workspace allows both policy models. */
async function seedAgent(): Promise<AgentFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(actor, [
    {
      model: WORKSPACE_DEFAULT_MODEL,
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    {
      model: OTHER_WORKSPACE_MODEL,
      isDefault: false,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread create agent",
    visibility: "private",
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
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
  readonly runId?: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    // Run tokens always carry a real run id, and thread creation reads that
    // run's model, so an unrelated id still has to be a uuid.
    runId: args.runId ?? randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function threadsClient() {
  return setupApp({ context })(chatThreadsContract);
}

function metadataClient() {
  return setupApp({ context })(chatThreadMetadataContract);
}

describe("POST /api/zero/chat-threads", () => {
  it("creates a titled thread with ZERO_TOKEN chat-thread:write capability", async () => {
    const fixture = await seedAgent();
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          title: "Deep dive on P2",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );
    expect(response.body).toMatchObject({
      title: "Deep dive on P2",
      selectedModel: OTHER_WORKSPACE_MODEL,
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: response.body.id },
      }),
      [200],
    );
    expect(metadataResponse.body).toStrictEqual({
      id: response.body.id,
      agentId: fixture.agentId,
      title: "Deep dive on P2",
      selectedModel: OTHER_WORKSPACE_MODEL,
    });
  });

  it("inherits the model of the run that owns the token when model is omitted", async () => {
    const fixture = await seedAgent();
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.agentId,
        triggerSource: "web",
        selectedModel: OTHER_WORKSPACE_MODEL,
      },
      context.signal,
    );
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
      runId,
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: { agentId: fixture.agentId, title: "Inherited model" },
      }),
      [201],
    );
    expect(response.body.selectedModel).toBe(OTHER_WORKSPACE_MODEL);

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: response.body.id },
      }),
      [200],
    );
    expect(metadataResponse.body.selectedModel).toBe(OTHER_WORKSPACE_MODEL);
  });

  it("rejects an omitted model when the token has no run model to inherit", async () => {
    const fixture = await seedAgent();
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:write"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: { agentId: fixture.agentId, title: "No model anywhere" },
      }),
      [400],
    );
    expect(response.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "A model selection is required",
      },
    });
  });

  it("rejects ZERO_TOKEN without chat-thread:write capability", async () => {
    const fixture = await seedAgent();
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          title: "Unauthorized thread",
          model: WORKSPACE_DEFAULT_MODEL,
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
