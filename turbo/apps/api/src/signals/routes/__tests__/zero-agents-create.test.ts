import { randomUUID } from "node:crypto";

import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  automationsByRefContract,
  automationsMainContract,
} from "@vm0/api-contracts/contracts/automations";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const authOrgApi = createAuthOrgAgentsBddApi(context);
const mocks = createZeroRouteMocks(context);

type AgentsFixture = ApiTestUser & { readonly orgId: string };

function agentsFixture(prefix: string): AgentsFixture {
  const actor = authOrgApi.user({
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
  });
  if (!actor.orgId) {
    throw new Error("Expected agent fixture to have an organization");
  }
  return {
    ...actor,
    orgId: actor.orgId,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentsByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function automationsClient() {
  return setupApp({ context })(automationsMainContract);
}

function automationsByRefClient() {
  return setupApp({ context })(automationsByRefContract);
}

function modelProvidersClient() {
  return setupApp({ context })(zeroModelProvidersMainContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function completeLimitedFreeWorkspace(
  fixture: AgentsFixture,
): Promise<void> {
  authOrgApi.acceptAgentStorageWrites();
  const completed = await authOrgApi.completeLimitedFreeOnboarding(fixture);
  if (completed.status !== 200) {
    throw new Error(
      `Expected limited-free onboarding to succeed, got ${completed.status}`,
    );
  }
  const setup = await authOrgApi.setupOnboarding(fixture, {
    displayName: "BDD Agent Create Workspace",
  });
  if (setup.status !== 200 && setup.status !== 409) {
    throw new Error(
      `Expected onboarding setup to succeed, got ${setup.status}`,
    );
  }
}

describe("POST /api/zero/agents", () => {
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

  it("creates agent metadata", async () => {
    const fixture = agentsFixture("create");
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
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
    expect(response.body.agentId).toStrictEqual(expect.any(String));
  });

  it("returns 409 when the public agent limit has been reached", async () => {
    const fixture = agentsFixture("limit");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    for (let index = 0; index < 7; index += 1) {
      await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: `Limit Agent ${index + 1}` },
        }),
        [201],
      );
    }

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
  });

  it("excludes private agents from the public agent create limit", async () => {
    const fixture = agentsFixture("private-limit");
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
    const fixture = agentsFixture("delete-limit");
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

  it("executes an automation for an agent created via POST /api/zero/agents", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const fixture = agentsFixture("automation");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await completeLimitedFreeWorkspace(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await accept(
      modelProvidersClient().upsert({
        headers: authHeaders(),
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
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
      automationsClient().create({
        headers: authHeaders(),
        body: {
          agentId: created.body.agentId,
          name: "zero-api-run",
          instruction: "Scheduled run",
          trigger: { kind: "cron", cronExpression: "0 9 * * *" },
        },
      }),
      [201],
    );

    const enabled = await accept(
      automationsByRefClient().enable({
        params: { ref: deployed.body.automation.id },
        headers: authHeaders(),
        body: {},
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();

    const run = await accept(
      automationsByRefClient().run({
        params: { ref: deployed.body.automation.id },
        headers: authHeaders(),
        body: {},
      }),
      [201],
    );
    expect(run.body.runId).toStrictEqual(expect.any(String));
  });
});
