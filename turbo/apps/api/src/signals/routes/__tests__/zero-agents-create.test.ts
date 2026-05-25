import { randomUUID } from "node:crypto";

import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroScheduleRunContract,
  zeroSchedulesEnableContract,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { and, count, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgModelProviders$,
  type OrgModelProviderFixture,
} from "./helpers/zero-model-providers";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
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
const ORG_SENTINEL_USER_ID = "__org__";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentsByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function schedulesClient() {
  return setupApp({ context })(zeroSchedulesMainContract);
}

function scheduleEnableClient() {
  return setupApp({ context })(zeroSchedulesEnableContract);
}

function scheduleRunClient() {
  return setupApp({ context })(zeroScheduleRunContract);
}

async function seedDefaultAnthropicProvider(
  orgId: string,
): Promise<OrgModelProviderFixture> {
  const db = store.set(writeDb$);
  const [secret] = await db
    .insert(secrets)
    .values({
      name: "ANTHROPIC_API_KEY",
      encryptedValue: encryptSecretForTests("test-secret-value"),
      type: "model-provider",
      userId: ORG_SENTINEL_USER_ID,
      orgId,
    })
    .returning({ id: secrets.id });

  if (!secret) {
    throw new Error("Expected model provider secret");
  }

  await db.insert(modelProviders).values({
    type: "anthropic-api-key",
    secretId: secret.id,
    isDefault: true,
    userId: ORG_SENTINEL_USER_ID,
    orgId,
  });

  return { orgId };
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
  const trackModelProvider = createFixtureTracker<OrgModelProviderFixture>(
    (fixture) => {
      return store.set(deleteOrgModelProviders$, fixture, context.signal);
    },
  );

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
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(content.volumes).toBeUndefined();

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

  it("excludes private agents from the public agent create limit", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    for (let index = 0; index < 7; index += 1) {
      const response = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: `Public ${index + 1}` },
        }),
        [201],
      );
      expect(response.body.visibility).toBe("public");
    }

    const privateResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Private", visibility: "private" },
      }),
      [201],
    );
    expect(privateResponse.body.visibility).toBe("private");

    const publicResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Public Over Limit" },
      }),
      [409],
    );
    expect(publicResponse.body.error.code).toBe("CONFLICT");
  });

  it("allows creating another public agent after one is deleted", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});
    const createdAgentIds: string[] = [];

    for (let index = 0; index < 7; index += 1) {
      const response = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: `Agent ${index + 1}` },
        }),
        [201],
      );
      createdAgentIds.push(response.body.agentId);
    }

    const blocked = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Blocked" },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CONFLICT");

    const deletedAgentId = createdAgentIds[0];
    if (!deletedAgentId) {
      throw new Error("Expected a created agent");
    }
    const deleteResponse = await accept(
      agentsByIdClient().delete({
        params: { id: deletedAgentId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(deleteResponse.body).toBeUndefined();

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "After Delete" },
      }),
      [201],
    );
    expect(response.body.displayName).toBe("After Delete");
  });

  it("executes a schedule for an agent created via POST /api/zero/agents", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await trackModelProvider(seedDefaultAnthropicProvider(fixture.orgId));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Schedule Bug Agent" },
      }),
      [201],
    );

    const deployed = await accept(
      schedulesClient().deploy({
        headers: authHeaders(),
        body: {
          agentId: created.body.agentId,
          name: "zero-api-run",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Scheduled run",
        },
      }),
      [201],
    );

    const enabled = await accept(
      scheduleEnableClient().enable({
        params: { name: "zero-api-run" },
        headers: authHeaders(),
        body: { agentId: created.body.agentId },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();

    const run = await accept(
      scheduleRunClient().run({
        headers: authHeaders(),
        body: { scheduleId: deployed.body.schedule.id },
      }),
      [201],
    );
    expect(run.body.runId).toStrictEqual(expect.any(String));
  });
});
