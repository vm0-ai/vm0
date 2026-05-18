import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET as listAgents } from "../route";
import {
  createTestRequest,
  createTestCliToken,
  createTestOrgModelProvider,
  createTestSandboxToken,
  createTestSchedule,
  enableTestSchedule,
  insertOrgMembersCacheEntry,
  insertOrgModelPolicy,
  createTestZeroSkill,
} from "../../../../../src/__tests__/api-test-helpers";
import { getTestComposeVersionContent } from "../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { POST as runSchedule } from "../../schedules/run/route";

const context = testContext();

let user: UserContext;
let testCliToken: string;

async function createAnthropicModelPolicy(orgId: string): Promise<void> {
  const provider = await createTestOrgModelProvider(
    "anthropic-api-key",
    "test-key",
  );
  await insertOrgModelPolicy({
    orgId,
    model: "claude-sonnet-4-6",
    isDefault: true,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: provider.id,
  });
}

function postAgent(body: Record<string, unknown>, token: string) {
  return POST(
    createTestRequest(`http://localhost:3000/api/zero/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function listAgentsReq(token: string) {
  return listAgents(
    createTestRequest(`http://localhost:3000/api/zero/agents`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

function listAgentsFromSession() {
  return listAgents(
    createTestRequest(`http://localhost:3000/api/zero/agents`, {
      method: "GET",
    }),
  );
}

describe("Zero Agents API", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
  });

  describe("POST /api/zero/agents", () => {
    it("should create an agent", async () => {
      const response = await postAgent({}, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.agentId).toBeTruthy();
      expect(data.ownerId).toBe(user.userId);
      expect(data.description).toBeNull();
      expect(data.displayName).toBeNull();
      expect(data.sound).toBeNull();
    });

    it("should create an agent with metadata", async () => {
      const response = await postAgent(
        {
          displayName: "My Agent",
          description: "A helpful agent",
          sound: "professional",
        },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.displayName).toBe("My Agent");
      expect(data.description).toBe("A helpful agent");
      expect(data.sound).toBe("professional");
    });

    it("should create an agent with connector env var templates in compose", async () => {
      const response = await postAgent({}, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();

      // Verify compose content includes connector env var templates
      const content = await getTestComposeVersionContent(data.agentId);
      const agents = content?.agents as Record<
        string,
        { environment: Record<string, string> }
      >;
      const agentEnv = Object.values(agents)[0]!.environment;

      // Base env vars present
      expect(agentEnv.ZERO_AGENT_ID).toBe("${{ vars.ZERO_AGENT_ID }}");
      expect(agentEnv.ZERO_TOKEN).toBe("${{ secrets.ZERO_TOKEN }}");
      // GA connector env vars present (GitHub is GA, not behind feature flag)
      expect(agentEnv.GH_TOKEN).toBe("${{ secrets.GH_TOKEN }}");
      expect(agentEnv.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    });

    it("should create an agent with custom skills persisted in response", async () => {
      await createTestZeroSkill(user.orgId, "my-skill");
      await createTestZeroSkill(user.orgId, "data-tool");

      const response = await postAgent(
        { customSkills: ["my-skill", "data-tool"] },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.customSkills).toEqual(["my-skill", "data-tool"]);

      // Custom skill volumes are no longer in compose — they are injected
      // as additionalVolumes at run creation time
      const content = await getTestComposeVersionContent(data.agentId);
      expect(content?.volumes).toBeUndefined();
    });

    it("should reject non-existent custom skill names", async () => {
      const response = await postAgent(
        { customSkills: ["does-not-exist"] },
        testCliToken,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("does-not-exist");
      expect(data.error.message).toContain("not found");
    });

    it("should reject connector type names as custom skills", async () => {
      const response = await postAgent(
        { customSkills: ["github"] },
        testCliToken,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("github");
      expect(data.error.message).toContain("connector");
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });

      const response = await postAgent({}, "no-token");
      expect(response.status).toBe(401);
    });

    it("should return 409 when org has reached the agent limit", async () => {
      // Create 7 agents (the maximum)
      for (let i = 0; i < 7; i++) {
        const response = await postAgent(
          { displayName: `Agent ${i + 1}` },
          testCliToken,
        );
        expect(response.status).toBe(201);
      }

      // 8th agent should be rejected
      const response = await postAgent(
        { displayName: "Over Limit" },
        testCliToken,
      );

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error.code).toBe("CONFLICT");
      expect(data.error.message).toContain("maximum number of agents");
    });

    it("should exclude private agents from the public agent limit", async () => {
      for (let i = 0; i < 7; i++) {
        const response = await postAgent(
          { displayName: `Public ${i + 1}` },
          testCliToken,
        );
        expect(response.status).toBe(201);
      }

      const privateResponse = await postAgent(
        { displayName: "Private", visibility: "private" },
        testCliToken,
      );
      expect(privateResponse.status).toBe(201);
      const privateAgent = await privateResponse.json();
      expect(privateAgent.visibility).toBe("private");

      const publicResponse = await postAgent(
        { displayName: "Public Over Limit" },
        testCliToken,
      );
      expect(publicResponse.status).toBe(409);
    });
  });

  describe("sandbox token (VM0_TOKEN) access", () => {
    it("sandbox token cannot create agent", async () => {
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: user.orgId });
      const sandboxToken = await createTestSandboxToken(user.userId, "run-123");

      const response = await postAgent({ connectors: [] }, sandboxToken);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/zero/agents", () => {
    it("should return empty array when no agents exist", async () => {
      const response = await listAgentsReq(testCliToken);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toStrictEqual([]);
    });

    it("should return list with created agent", async () => {
      const created = await (
        await postAgent(
          {
            displayName: "Listed Agent",
            description: "desc",
            sound: "friendly",
          },
          testCliToken,
        )
      ).json();

      const response = await listAgentsReq(testCliToken);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].agentId).toBe(created.agentId);
      expect(data[0].ownerId).toBe(user.userId);
      expect(data[0].displayName).toBe("Listed Agent");
      expect(data[0].description).toBe("desc");
      expect(data[0].sound).toBe("friendly");
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });
      const response = await listAgentsReq("no-token");
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("should return 401 when the authenticated session has no active organization", async () => {
      mockClerk({ userId: user.userId, orgId: null });

      const response = await listAgentsFromSession();

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("should only list agents from the active organization", async () => {
      const otherUser = await context.setupUser({ prefix: "other-agent-user" });
      mockClerk({
        userId: otherUser.userId,
        orgId: otherUser.orgId,
        orgRole: "org:admin",
      });
      const otherToken = await createTestCliToken(
        otherUser.userId,
        undefined,
        otherUser.orgId,
      );
      const createResponse = await postAgent(
        { displayName: "Other Org Agent" },
        otherToken,
      );
      expect(createResponse.status).toBe(201);
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });

      const response = await listAgentsReq(testCliToken);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual([]);
    });
  });

  describe("schedule run integration", () => {
    it("should execute schedule for agent created via POST /api/zero/agents", async () => {
      // Regression: serverSideCompose was called without instructions param,
      // so agent-instructions storage was never created. Schedule runs then
      // failed with "Storage agent-instructions@<id> not found".
      await createAnthropicModelPolicy(user.orgId);

      // 1. Create agent via POST /api/zero/agents
      const createResponse = await postAgent(
        { displayName: "Schedule Bug Agent" },
        testCliToken,
      );
      expect(createResponse.status).toBe(201);
      const agent = await createResponse.json();

      // 2. Create and enable a schedule
      const schedule = await createTestSchedule(agent.agentId, "zero-api-run", {
        cronExpression: "0 9 * * *",
        prompt: "Scheduled run",
      });
      await enableTestSchedule(agent.agentId, "zero-api-run");

      // 3. Execute the schedule — should succeed
      const response = await runSchedule(
        createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduleId: schedule.id }),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
    });
  });
});
