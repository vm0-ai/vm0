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
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { count, eq } from "drizzle-orm";

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

// BDD migration of the legacy `zero-agents-create.test.ts`.
// The 9 legacy `it()`s collapse into 4 BDD `it()`s: (1) auth
// + 403 chain (401 unauth → 403 zero token without
// `agent:write` capability), (2) success chain (201 creates
// agent metadata + compose content + instructions storage +
// S3 send + public visibility), (3) validation + limit chain
// (400 missing custom skill → 400 built-in connector as
// skill → 409 public limit + private exempt → 409 → 204
// delete → 201 create after delete), (4) schedule run chain
// (201 create + 201 deploy + 200 enable + 201 schedule run
// creates a real run).
//
// The legacy "stored content" assertions verify the head
// version content via direct DB SELECT against
// `agentComposeVersions`. The BDD version verifies the
// public response shape (the `zeroAgentResponseSchema` is
// the same shape the legacy test reconstructed). The S3
// mock send count is verified through
// `context.mocks.s3.send.mock.calls`. The "compose +
// instructions storage rows exist" check is verified
// through `context.mocks.s3.send` call count (the legacy
// test asserted 2 S3 sends per create).
//
// The "7 public agents" limit test uses
// `seedAgentForInstructions$` to seed 7 pre-existing
// agents via direct DB writes (Open Helper Gap — the
// public API does not expose a "bulk-seed 7 agents"
// primitive). The "private exempt" chain follows the
// legacy test exactly: create 7 public, then 1 private
// (allowed), then another public (409).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function authHeaders(): { readonly authorization: string } {
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

const track = createFixtureTracker<SkillsFixture>((fixture) => {
  return store.set(deleteSkillsForFixture$, fixture, context.signal);
});

const trackModelProvider = createFixtureTracker<OrgModelProviderFixture>(
  (fixture) => {
    return store.set(deleteOrgModelProviders$, fixture, context.signal);
  },
);

describe("BDD POST /api/zero/agents — auth + capability chain", () => {
  it("gwt-wt-wt: 401 unauth → 403 zero token without agent:write capability", async () => {
    // When + Then: 401 unauth.
    const unauth = await accept(
      agentsClient().create({ headers: {}, body: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a zero-scope JWT with the wrong capability.
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

    // When + Then: 403 — the zero token lacks `agent:write`.
    const forbidden = await accept(
      agentsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {},
      }),
      [403],
    );
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:write",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD POST /api/zero/agents — success chain", () => {
  it("gwt-wt-wt: 201 creates agent metadata + compose content + instructions storage + S3 sends", async () => {
    // Given: a fresh org with a seeded custom skill.
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

    // When: 201 create with full metadata + custom skill.
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

    // Then: the response carries the full metadata + the
    // generated agentId.
    expect(response.body).toMatchObject({
      ownerId: fixture.userId,
      displayName: "Research Agent",
      description: "Tracks research context",
      sound: "calm",
      avatarUrl: "preset:2",
      customSkills: ["research-notes"],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
    expect(response.body.agentId).toStrictEqual(expect.any(String));

    // Then: the persisted state matches the response — the
    // agent row, the compose row, the head version content,
    // the instructions storage row.
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
    expect(agent).toMatchObject({
      id: response.body.agentId,
      owner: fixture.userId,
      customSkills: ["research-notes"],
      visibility: "public",
    });
    if (!agent) {
      throw new Error("Expected agent");
    }

    const [compose] = await db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, response.body.agentId));
    expect(compose?.id).toBe(response.body.agentId);
    expect(compose?.name).toBe(agent.name);
    expect(compose?.headVersionId).toMatch(/^[a-f0-9]{64}$/);

    const headVersionId = compose?.headVersionId;
    if (!headVersionId) {
      throw new Error("Expected created compose with head version");
    }

    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, headVersionId));
    const content = version?.content as Record<string, unknown> | undefined;
    expect(content).toBeDefined();
    const agents = content?.agents as Record<string, unknown> | undefined;
    expect(agents).toBeDefined();
    const storedAgent = agents?.[agent.name] as
      | Record<string, unknown>
      | undefined;
    expect(storedAgent?.framework).toBe("claude-code");
    expect(storedAgent?.instructions).toBe("CLAUDE.md");

    const [instructionsStorage] = await db
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.orgId, fixture.orgId));
    expect(instructionsStorage?.headVersionId).toMatch(/^[a-f0-9]{64}$/);

    // Then: S3 was called 2x (archive upload + manifest upload).
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(2);
  });
});

describe("BDD POST /api/zero/agents — validation + limit chain", () => {
  it("gwt-wt-wt: 400 missing custom skill → 400 built-in connector as skill → 409 public limit → 409 → 204 delete → 201 create after delete", async () => {
    // Given: a fresh org with no skills.
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 400 — unknown custom skill.
    const missingSkill = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { customSkills: ["missing-skill"] },
      }),
      [400],
    );
    expect(missingSkill.body).toStrictEqual({
      error: {
        message:
          "Custom skill 'missing-skill' not found in this organization. Create it with 'zero skill create' first.",
        code: "VALIDATION_ERROR",
      },
    });

    // When + Then: 400 — built-in connector masquerading as
    // a custom skill.
    const builtInAsSkill = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { customSkills: ["github"] },
      }),
      [400],
    );
    expect(builtInAsSkill.body).toStrictEqual({
      error: {
        message:
          "'github' is a built-in connector, not a custom skill. Enable it via connectors instead.",
        code: "VALIDATION_ERROR",
      },
    });

    // Given: a fresh org with 7 already-created public
    // agents (Open Helper Gap — direct DB writes to seed
    // the pre-condition).
    const limitFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    for (let i = 0; i < 7; i += 1) {
      await store.set(
        seedAgentForInstructions$,
        {
          orgId: limitFixture.orgId,
          userId: limitFixture.userId,
          visibility: "public",
        },
        context.signal,
      );
    }
    mocks.clerk.session(limitFixture.userId, limitFixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    // When + Then: 409 — public agent limit reached, and no
    // S3 calls were made (the create was rejected before
    // touching the storage).
    const atLimit = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: {},
      }),
      [409],
    );
    expect(atLimit.body).toStrictEqual({
      error: {
        message:
          "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    // Then: the persisted row counts match the limit.
    const db = store.set(writeDb$);
    const [composeCount] = await db
      .select({ value: count() })
      .from(agentComposes)
      .where(eq(agentComposes.orgId, limitFixture.orgId));
    const [zeroAgentCount] = await db
      .select({ value: count() })
      .from(zeroAgents)
      .where(eq(zeroAgents.orgId, limitFixture.orgId));
    expect(composeCount?.value).toBe(7);
    expect(zeroAgentCount?.value).toBe(7);

    // Given: a fresh org.
    const exemptFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(exemptFixture.userId, exemptFixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    // When: 7 public creates — all succeed.
    const createdAgentIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: `Public ${index + 1}` },
        }),
        [201],
      );
      expect(response.body.visibility).toBe("public");
      createdAgentIds.push(response.body.agentId);
    }

    // When + Then: 201 — a private agent is allowed even
    // when the public limit is reached.
    const privateResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Private", visibility: "private" },
      }),
      [201],
    );
    expect(privateResponse.body.visibility).toBe("private");

    // When + Then: 409 — another public agent is blocked.
    const blocked = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Public Over Limit" },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CONFLICT");

    // When + Then: 204 delete the first public agent + 201
    // create a new public agent (the slot is freed).
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

    const afterDelete = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "After Delete" },
      }),
      [201],
    );
    expect(afterDelete.body.displayName).toBe("After Delete");
  });
});

describe("BDD POST /api/zero/agents — schedule run chain", () => {
  it("gwt-wt-wt: 201 create + 201 deploy + 200 enable + 201 schedule run", async () => {
    // Given: a fresh org with a default Anthropic provider
    // (so the schedule run has a real framework to dispatch).
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await trackModelProvider(seedDefaultAnthropicProvider(fixture.orgId));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    // When: 201 create.
    const created = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Schedule Bug Agent" },
      }),
      [201],
    );

    // When: 201 deploy a schedule.
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

    // When + Then: 200 enable the schedule.
    const enabled = await accept(
      scheduleEnableClient().enable({
        params: { name: "zero-api-run" },
        headers: authHeaders(),
        body: { agentId: created.body.agentId },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();

    // When + Then: 201 schedule run creates a real run.
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
