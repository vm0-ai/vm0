import { randomUUID } from "node:crypto";

import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { and, count, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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
const ZERO_AGENT_ID_TEMPLATE = ["$", "{{ vars.ZERO_AGENT_ID }}"].join("");
const ZERO_TOKEN_TEMPLATE = ["$", "{{ secrets.ZERO_TOKEN }}"].join("");

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

describe("POST /api/zero/agents", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().create({ headers: {}, body: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for a zero token without agent:write capability", async () => {
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
      agentsClient().create({
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

  it("creates agent metadata, compose content, and instructions storage", async () => {
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
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Research Agent",
          description: "Tracks research context",
          sound: "calm",
          avatarUrl: "preset:2",
          customSkills: ["research-notes"],
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      ownerId: fixture.userId,
      displayName: "Research Agent",
      description: "Tracks research context",
      sound: "calm",
      avatarUrl: "preset:2",
      permissionPolicies: null,
      customSkills: ["research-notes"],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
    expect(response.body.agentId).toStrictEqual(expect.any(String));

    const db = store.set(writeDb$);
    const [agent] = await db
      .select({
        id: zeroAgents.id,
        name: zeroAgents.name,
        owner: zeroAgents.owner,
        customSkills: zeroAgents.customSkills,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, response.body.agentId));
    expect(agent).toStrictEqual({
      id: response.body.agentId,
      name: expect.any(String),
      owner: fixture.userId,
      customSkills: ["research-notes"],
      visibility: "public",
    });

    const [compose] = await db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, response.body.agentId));
    expect(compose?.id).toBe(response.body.agentId);
    expect(compose?.name).toBe(agent?.name);
    expect(compose?.headVersionId).toMatch(/^[a-f0-9]{64}$/);

    const headVersionId = compose?.headVersionId;
    if (!headVersionId || !compose?.name) {
      throw new Error("Expected created compose with head version");
    }

    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, headVersionId));
    const content = expectRecord(version?.content, "compose content");
    const agents = expectRecord(content.agents, "compose agents");
    const storedAgent = expectRecord(agents[compose.name], "stored agent");
    const environment = expectRecord(
      storedAgent.environment,
      "stored agent environment",
    );
    expect(storedAgent.framework).toBe("claude-code");
    expect(storedAgent.instructions).toBe("CLAUDE.md");
    expect(environment.ZERO_AGENT_ID).toBe(ZERO_AGENT_ID_TEMPLATE);
    expect(environment.ZERO_TOKEN).toBe(ZERO_TOKEN_TEMPLATE);

    const [instructionsStorage] = await db
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, fixture.orgId),
          eq(storages.name, getInstructionsStorageName(compose.name)),
        ),
      );
    expect(instructionsStorage?.headVersionId).toMatch(/^[a-f0-9]{64}$/);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when a requested custom skill does not exist", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().create({
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().create({
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

  it("returns 403 when private visibility is requested while the feature is disabled", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { visibility: "private" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Private agents are not available for this account",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 409 when the public agent limit has been reached", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    for (let i = 0; i < 7; i += 1) {
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
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: {},
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
        code: "CONFLICT",
      },
    });

    const db = store.set(writeDb$);
    const [composeCount] = await db
      .select({ value: count() })
      .from(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    const [zeroAgentCount] = await db
      .select({ value: count() })
      .from(zeroAgents)
      .where(eq(zeroAgents.orgId, fixture.orgId));

    expect(composeCount?.value).toBe(7);
    expect(zeroAgentCount?.value).toBe(7);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});
