import { randomUUID } from "node:crypto";

import {
  zeroAgentInstructionsContract,
  zeroAgentsByIdContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken, signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteSkillsForFixture$,
  seedAgentForInstructions$,
  seedSkill$,
  seedSkillsFixture$,
  type SkillsFixture,
} from "./helpers/zero-skills";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function cliAuthHeaders(
  fixture: SkillsFixture,
  role: "admin" | "member" = "admin",
): Promise<{ readonly authorization: string }> {
  const tokenId = randomUUID();
  const token = generateCliToken(fixture.userId, fixture.orgId, tokenId);
  const writeDb = store.set(writeDb$);
  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: fixture.userId,
    name: "Test Token",
    expiresAt: new Date(now() + 60 * 60 * 1000),
  });
  await writeDb
    .insert(orgMembersCache)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role,
      cachedAt: new Date(now() + 60 * 1000),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        role,
        cachedAt: new Date(now() + 60 * 1000),
      },
    });

  return { authorization: `Bearer ${token}` };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function instructionsClient() {
  return setupApp({ context })(zeroAgentInstructionsContract);
}

function s3CommandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function s3PutInputs(): readonly Record<string, unknown>[] {
  return context.mocks.s3.send.mock.calls.map(([command]) => {
    return s3CommandInput(command);
  });
}

describe("PUT /api/zero/agents/:id", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for a sandbox token without agent:write capability", async () => {
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      agentsClient().update({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 for invalid path params", async () => {
    const response = await accept(
      agentsClient().update({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
        body: {},
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("updates agent metadata, validates custom skills and model selection, and preserves omitted fields", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "research-notes",
      },
      context.signal,
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Old Agent",
        sound: "calm",
        customSkills: ["old-skill"],
        modelProviderId: null,
        selectedModel: "claude-sonnet-4-6",
        preferPersonalProvider: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: {
          displayName: "Updated Agent",
          customSkills: ["research-notes"],
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      displayName: "Updated Agent",
      sound: "calm",
      customSkills: ["research-notes"],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });

    const [compose] = await store
      .set(writeDb$)
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, agent.agentId));
    expect(compose?.headVersionId).toBeTruthy();
  });

  it("preserves existing custom skills when the request omits customSkills", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        customSkills: ["existing-skill"],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { description: "Updated description" },
      }),
      [200],
    );

    expect(response.body.customSkills).toStrictEqual(["existing-skill"]);
    expect(response.body.description).toBe("Updated description");
  });

  it("allows an owner member to update their own agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Member Agent",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Member Updated" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      displayName: "Member Updated",
    });
  });

  it("returns 400 when a requested custom skill does not exist", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { customSkills: ["missing-skill"] },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Custom skill 'missing-skill' not found in this organization. Create it with 'zero skill create' first.",
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("returns 400 when a built-in connector is requested as a custom skill", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { customSkills: ["github"] },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "'github' is a built-in connector, not a custom skill. Enable it via connectors instead.",
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("clears stale model fields on PUT", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        modelProviderId: null,
        selectedModel: "claude-sonnet-4-6",
        preferPersonalProvider: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Cleared Agent" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });

  it("returns 403 when a non-owner member updates another user's agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Nope" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can update agent configuration",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 for an unknown agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const agentId = randomUUID();

    const response = await accept(
      agentsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: {},
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });
});

describe("PATCH /api/zero/agents/:id", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: randomUUID() },
        headers: {},
        body: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for a sandbox token without agent:write capability", async () => {
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("updates metadata fields and preserves omitted fields without recomposing", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Original Agent",
        description: "Original description",
        sound: "calm",
        avatarUrl: "preset:4",
        customSkills: ["existing-skill"],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: {
          displayName: "Updated Agent",
          description: "Updated description",
          avatarUrl: null,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      displayName: "Updated Agent",
      description: "Updated description",
      sound: "calm",
      avatarUrl: null,
      customSkills: ["existing-skill"],
      preferPersonalProvider: false,
    });

    const [compose] = await store
      .set(writeDb$)
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, agent.agentId));
    expect(compose?.headVersionId).toBeNull();
  });

  it("returns 400 for invalid path params", async () => {
    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
        body: { displayName: "Invalid" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 for an unknown agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const agentId = randomUUID();

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agentId },
        headers: authHeaders(),
        body: {},
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 403 when a non-owner member updates another user's agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Nope" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner or org admin can update agent profile",
        code: "FORBIDDEN",
      },
    });
  });

  it("allows an org admin to update another user's public agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const adminUserId = `user_${randomUUID()}`;
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Owner Agent",
      },
      context.signal,
    );
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Admin Updated" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      displayName: "Admin Updated",
    });
  });

  it("returns 403 when an org admin changes another user's public agent visibility", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const adminUserId = `user_${randomUUID()}`;
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        visibility: "public",
      },
      context.signal,
    );
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { visibility: "private" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner can update agent visibility",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 403 when an org admin updates another user's private agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const adminUserId = `user_${randomUUID()}`;
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Admin Updated" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the private agent owner can update agent profile",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 409 when changing a private agent to public would exceed the public limit", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    for (let index = 0; index < 7; index += 1) {
      await store.set(
        seedAgentForInstructions$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          visibility: "public",
        },
        context.signal,
      );
    }
    const privateAgent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: privateAgent.agentId },
        headers: authHeaders(),
        body: { visibility: "public" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
        code: "CONFLICT",
      },
    });
  });

  it("allows an owner to update private agent metadata without changing visibility", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Private Agent",
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Owner Updated Private Agent" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      displayName: "Owner Updated Private Agent",
      visibility: "private",
    });
  });

  it("clears stale model fields on PATCH", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        modelProviderId: null,
        selectedModel: "claude-sonnet-4-6",
        preferPersonalProvider: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Cleared Agent" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });

  it("clears stale agent model fields on PATCH", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        modelProviderId: null,
        selectedModel: "claude-sonnet-4-6",
        preferPersonalProvider: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: {
          displayName: "Still no model",
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });

    const [row] = await store
      .set(writeDb$)
      .select({
        modelProviderId: zeroAgents.modelProviderId,
        selectedModel: zeroAgents.selectedModel,
        preferPersonalProvider: zeroAgents.preferPersonalProvider,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, agent.agentId));
    expect(row).toStrictEqual({
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });
});

describe("PUT /api/zero/agents/:id/instructions", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      instructionsClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: { content: "new instructions" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for a sandbox token without agent:write capability", async () => {
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      instructionsClient().update({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
        body: { content: "new instructions" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 for an invalid agent id", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().update({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
        body: { content: "new instructions" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "id: Invalid UUID",
        code: "BAD_REQUEST",
      },
    });
  });

  it("updates instructions storage and preserves agent metadata", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Instructions Agent",
        customSkills: ["existing-skill"],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { content: "Use the updated operating notes." },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      displayName: "Instructions Agent",
      customSkills: ["existing-skill"],
    });

    const putInputs = s3PutInputs();
    const manifestPut = putInputs.find((input) => {
      return String(input.Key).endsWith("/manifest.json");
    });
    const archivePut = putInputs.find((input) => {
      return String(input.Key).endsWith("/archive.tar.gz");
    });
    expect(manifestPut?.Bucket).toBe("test-user-storages");
    expect(archivePut?.Bucket).toBe("test-user-storages");

    const manifestBody = JSON.parse(String(manifestPut?.Body)) as {
      readonly files: readonly { readonly path: string }[];
    };
    const paths = manifestBody.files.map((file) => {
      return file.path;
    });
    expect(paths).toStrictEqual(["CLAUDE.md", "AGENTS.md"]);
  });

  it("allows an owner CLI token to update instructions", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "CLI Instructions Agent",
      },
      context.signal,
    );

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: await cliAuthHeaders(fixture, "member"),
        body: { content: "Use CLI-authenticated operating notes." },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      displayName: "CLI Instructions Agent",
    });
  });

  it("allows an owner member to update private agent instructions", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { content: "owner update" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: fixture.userId,
      visibility: "private",
    });
  });

  it("returns 403 when a non-owner member updates another user's instructions", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { content: "not allowed" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can update agent instructions",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 for an unknown agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const agentId = randomUUID();

    const response = await accept(
      instructionsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { content: "missing" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });
});
