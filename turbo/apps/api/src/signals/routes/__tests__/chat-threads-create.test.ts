import { randomUUID } from "node:crypto";

import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { seedRun$ } from "./helpers/usage-state";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { userModelPreferenceRoutes } from "../user-model-preference";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);

const WORKSPACE_DEFAULT_MODEL = "claude-sonnet-5";
const OTHER_WORKSPACE_MODEL = "claude-opus-4-8";
const PRIORITY_MODEL = "gpt-5.6-sol";
const EXPLICIT_VIDEO_MODEL = "fal-ai/veo3.1/fast";
const INHERITED_VIDEO_MODEL = "MiniMax-H3";
const EXPLICIT_IMAGE_MODEL = "fal-ai/qwen-image";
const INHERITED_IMAGE_MODEL = "gpt-image-2";
const MEMBER_VIDEO_MODEL = "seedance-1-5-pro-251215";
const MEMBER_IMAGE_MODEL = "fal-ai/flux-pro/v1.1";

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
    {
      model: PRIORITY_MODEL,
      isDefault: false,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
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
  readonly capabilities: readonly Capability[];
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
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

function preferenceClient() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}

/** The preference route only accepts a session, so zero tokens cannot seed it. */
async function setMemberMediaDefaults(fixture: AgentFixture): Promise<void> {
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  await accept(
    preferenceClient().update({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        selectedModel: null,
        serviceTier: null,
        selectedVideoModel: MEMBER_VIDEO_MODEL,
        selectedImageModel: MEMBER_IMAGE_MODEL,
      },
    }),
    [200],
  );
}

async function readCreatedThreadEvent(threadId: string, token: string) {
  const response = await accept(
    threadsClient().events({
      headers: { authorization: `Bearer ${token}` },
      query: {},
    }),
    [200],
  );
  const event = response.body.events.find((candidate) => {
    return candidate.kind === "created" && candidate.chatThreadId === threadId;
  });
  if (!event) {
    throw new Error(`Created event not found for thread ${threadId}`);
  }
  return event;
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
          videoModel: EXPLICIT_VIDEO_MODEL,
          imageModel: EXPLICIT_IMAGE_MODEL,
        },
      }),
      [201],
    );
    expect(response.body).toMatchObject({
      title: "Deep dive on P2",
      selectedModel: OTHER_WORKSPACE_MODEL,
      serviceTier: null,
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
      serviceTier: null,
    });
    await expect(
      readCreatedThreadEvent(response.body.id, token),
    ).resolves.toMatchObject({
      selectedVideoModel: EXPLICIT_VIDEO_MODEL,
      selectedImageModel: EXPLICIT_IMAGE_MODEL,
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
    expect(metadataResponse.body.serviceTier).toBeNull();
  });

  it("inherits media models from the run's chat thread when omitted", async () => {
    const fixture = await seedAgent();
    const sourceToken = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const source = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${sourceToken}` },
        body: {
          agentId: fixture.agentId,
          title: "Video model source",
          model: OTHER_WORKSPACE_MODEL,
          videoModel: INHERITED_VIDEO_MODEL,
          imageModel: INHERITED_IMAGE_MODEL,
        },
      }),
      [201],
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.agentId,
        triggerSource: "web",
        chatThreadId: source.body.id,
        selectedModel: OTHER_WORKSPACE_MODEL,
      },
      context.signal,
    );
    const inheritedToken = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
      runId,
    });

    const inherited = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${inheritedToken}` },
        body: {
          agentId: fixture.agentId,
          title: "Inherited media models",
        },
      }),
      [201],
    );

    await expect(
      readCreatedThreadEvent(inherited.body.id, inheritedToken),
    ).resolves.toMatchObject({
      selectedVideoModel: INHERITED_VIDEO_MODEL,
      selectedImageModel: INHERITED_IMAGE_MODEL,
    });
  });

  it("leaves media models unpinned while neither picker is enabled", async () => {
    const fixture = await seedAgent();
    await setMemberMediaDefaults(fixture);
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
          title: "No media pickers enabled",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );

    // A member who cannot reach either picker has no choice worth freezing, so
    // the thread keeps following the live defaults. A written pin would also
    // outlive a revert of this behavior.
    await expect(
      readCreatedThreadEvent(response.body.id, token),
    ).resolves.toMatchObject({
      selectedVideoModel: null,
      selectedImageModel: null,
    });
  });

  it("pins each media model whose picker is enabled", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.VideoModelSelection]: true,
    });
    await setMemberMediaDefaults(fixture);
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
          title: "Video picker only",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );

    // Each switch gates its own pin: the video default freezes, the image one
    // stays null until its picker ships.
    await expect(
      readCreatedThreadEvent(response.body.id, token),
    ).resolves.toMatchObject({
      selectedVideoModel: MEMBER_VIDEO_MODEL,
      selectedImageModel: null,
    });
  });

  it("pins the member media defaults when the request omits them", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.VideoModelSelection]: true,
      [FeatureSwitchKey.ImageModelSelection]: true,
    });
    await setMemberMediaDefaults(fixture);
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
          title: "Member media defaults",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );

    await expect(
      readCreatedThreadEvent(response.body.id, token),
    ).resolves.toMatchObject({
      selectedVideoModel: MEMBER_VIDEO_MODEL,
      selectedImageModel: MEMBER_IMAGE_MODEL,
    });
  });

  it("inherits priority from the run's chat thread and allows an explicit standard override", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.CodexFastMode]: true,
    });
    const sourceToken = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const source = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${sourceToken}` },
        body: {
          agentId: fixture.agentId,
          title: "Priority source",
          model: PRIORITY_MODEL,
          serviceTier: "priority",
        },
      }),
      [201],
    );
    expect(source.body.serviceTier).toBe("priority");

    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.agentId,
        triggerSource: "web",
        chatThreadId: source.body.id,
        selectedModel: PRIORITY_MODEL,
      },
      context.signal,
    );
    const inheritedToken = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
      runId,
    });

    const inherited = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${inheritedToken}` },
        body: { agentId: fixture.agentId, title: "Inherited priority" },
      }),
      [201],
    );
    expect(inherited.body).toMatchObject({
      selectedModel: PRIORITY_MODEL,
      serviceTier: "priority",
    });
    const inheritedMetadata = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${inheritedToken}` },
        params: { id: inherited.body.id },
      }),
      [200],
    );
    expect(inheritedMetadata.body.serviceTier).toBe("priority");

    const standard = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${inheritedToken}` },
        body: {
          agentId: fixture.agentId,
          title: "Explicit standard",
          serviceTier: null,
        },
      }),
      [201],
    );
    expect(standard.body).toMatchObject({
      selectedModel: PRIORITY_MODEL,
      serviceTier: null,
    });
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
