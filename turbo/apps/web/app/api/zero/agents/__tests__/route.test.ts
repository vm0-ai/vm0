import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET as listAgents } from "../route";
import { GET, PUT, PATCH, DELETE } from "../[id]/route";
import {
  createTestRequest,
  createTestCliToken,
  createTestCompose,
  createTestRun,
  createTestOrgModelProvider,
  createTestSandboxToken,
  createTestVolume,
  findTestStorageByName,
  findTestRunRecord,
  findTestUsageEvent,
  insertTestModelUsageEventForRun,
  insertTestSandboxTelemetry,
  findTestSandboxTelemetry,
  createTestSchedule,
  enableTestSchedule,
  createTestSessionWithConversation,
  setDefaultAgentByComposeId,
  clearOrgMembersCacheEntry,
  insertOrgMembersCacheEntry,
  insertOrgModelPolicy,
  createTestZeroSkill,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
} from "../../../../../src/__tests__/db-test-seeders/slack";
import { getTestComposeVersionContent } from "../../../../../src/__tests__/db-test-assertions/agents";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../src/lib/auth/sandbox-token";
import { POST as runSchedule } from "../../schedules/run/route";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";

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

function getAgent(name: string, token: string) {
  return GET(
    createTestRequest(`http://localhost:3000/api/zero/agents/${name}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

function getAgentFromSession(name: string) {
  return GET(
    createTestRequest(`http://localhost:3000/api/zero/agents/${name}`, {
      method: "GET",
    }),
  );
}

function putAgent(name: string, body: Record<string, unknown>, token: string) {
  return PUT(
    createTestRequest(`http://localhost:3000/api/zero/agents/${name}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function patchAgent(
  name: string,
  body: Record<string, unknown>,
  token: string,
) {
  return PATCH(
    createTestRequest(`http://localhost:3000/api/zero/agents/${name}`, {
      method: "PATCH",
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

function deleteAgent(name: string, token: string) {
  return DELETE(
    createTestRequest(`http://localhost:3000/api/zero/agents/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
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

    it("should allow creation after deleting an agent below the limit", async () => {
      // Create 7 agents
      const agents = [];
      for (let i = 0; i < 7; i++) {
        const response = await postAgent(
          { displayName: `Agent ${i + 1}` },
          testCliToken,
        );
        expect(response.status).toBe(201);
        agents.push(await response.json());
      }

      // 8th should be rejected
      const blocked = await postAgent({ displayName: "Blocked" }, testCliToken);
      expect(blocked.status).toBe(409);

      // Delete one agent
      const deleteRes = await deleteAgent(agents[0].agentId, testCliToken);
      expect(deleteRes.status).toBe(204);

      // Now creation should succeed
      const response = await postAgent(
        { displayName: "After Delete" },
        testCliToken,
      );
      expect(response.status).toBe(201);
    });
  });

  describe("GET /api/zero/agents/:name", () => {
    it("should return created agent", async () => {
      // Create an agent first
      const createResponse = await postAgent(
        {
          displayName: "Test Agent",
          description: "Test description",
          sound: "friendly",
        },
        testCliToken,
      );

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Get the agent
      const response = await getAgent(created.agentId, testCliToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agentId).toBe(created.agentId);
      expect(data.ownerId).toBe(user.userId);
      expect(data.displayName).toBe("Test Agent");
      expect(data.description).toBe("Test description");
      expect(data.sound).toBe("friendly");
    });

    it("should return 404 for unknown agent", async () => {
      const unknownId = "00000000-0000-0000-0000-000000000000";
      const response = await getAgent(unknownId, testCliToken);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data).toStrictEqual({
        error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
      });
    });

    it("should return 401 when the authenticated session has no active organization", async () => {
      const createResponse = await postAgent(
        { displayName: "No Org Detail" },
        testCliToken,
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();
      mockClerk({ userId: user.userId, orgId: null });

      const response = await getAgentFromSession(created.agentId);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("should return 404 for an agent from another org", async () => {
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
      const otherAgent = await createResponse.json();
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });

      const response = await getAgent(otherAgent.agentId, testCliToken);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          message: `Agent not found: ${otherAgent.agentId}`,
          code: "NOT_FOUND",
        },
      });
    });

    it("should only return private agents to their owner", async () => {
      const created = await (
        await postAgent(
          { displayName: "Owner Only", visibility: "private" },
          testCliToken,
        )
      ).json();

      const ownerGet = await getAgent(created.agentId, testCliToken);
      expect(ownerGet.status).toBe(200);
      expect((await ownerGet.json()).visibility).toBe("private");

      const otherUser = await context.setupUser({ prefix: "private-viewer" });
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: otherUser.userId,
        cachedAt: new Date(),
      });
      const otherToken = await createTestCliToken(
        otherUser.userId,
        undefined,
        user.orgId,
      );

      const otherGet = await getAgent(created.agentId, otherToken);
      expect(otherGet.status).toBe(404);

      const listResponse = await listAgentsReq(otherToken);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json();
      expect(
        list.some((agent: { agentId: string }) => {
          return agent.agentId === created.agentId;
        }),
      ).toBe(false);
    });
  });

  describe("PUT /api/zero/agents/:name", () => {
    it("should update agent metadata", async () => {
      // Create an agent first
      const createResponse = await postAgent(
        { displayName: "Original" },
        testCliToken,
      );
      const created = await createResponse.json();

      // Update the agent
      const response = await putAgent(
        created.agentId,
        {
          displayName: "Updated Name",
          description: "Updated description",
          sound: "casual",
        },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ownerId).toBe(user.userId);
      expect(data.displayName).toBe("Updated Name");
      expect(data.description).toBe("Updated description");
      expect(data.sound).toBe("casual");
    });

    it("should preserve metadata on update without metadata fields", async () => {
      // Create agent with metadata
      const createResponse = await postAgent(
        {
          displayName: "My Agent",
          description: "A helpful agent",
          sound: "professional",
        },
        testCliToken,
      );
      const created = await createResponse.json();

      // Update with no metadata fields
      const updateResponse = await putAgent(created.agentId, {}, testCliToken);
      expect(updateResponse.status).toBe(200);

      // Verify metadata is preserved
      const getRes = await getAgent(created.agentId, testCliToken);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.displayName).toBe("My Agent");
      expect(fetched.description).toBe("A helpful agent");
      expect(fetched.sound).toBe("professional");
    });

    it("should rebuild compose with connector env var templates", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await putAgent(
        created.agentId,
        { displayName: "Refreshed" },
        testCliToken,
      );
      expect(response.status).toBe(200);

      const content = await getTestComposeVersionContent(created.agentId);
      const agents = content?.agents as Record<
        string,
        { environment: Record<string, string> }
      >;
      const agentEnv = Object.values(agents)[0]!.environment;

      expect(agentEnv.GH_TOKEN).toBe("${{ secrets.GH_TOKEN }}");
      expect(agentEnv.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
      expect(agentEnv.ZERO_AGENT_ID).toBe("${{ vars.ZERO_AGENT_ID }}");
      expect(agentEnv.ZERO_TOKEN).toBe("${{ secrets.ZERO_TOKEN }}");
    });

    it("should update custom skills and persist them", async () => {
      await createTestZeroSkill(user.orgId, "my-skill");
      await createTestZeroSkill(user.orgId, "data-tool");

      const created = await (await postAgent({}, testCliToken)).json();

      const response = await putAgent(
        created.agentId,
        { customSkills: ["my-skill", "data-tool"] },
        testCliToken,
      );
      expect(response.status).toBe(200);

      // Verify skills are persisted
      const getRes = await getAgent(created.agentId, testCliToken);
      const fetched = await getRes.json();
      expect(fetched.customSkills).toEqual(["my-skill", "data-tool"]);

      // Custom skill volumes are no longer in compose
      const content = await getTestComposeVersionContent(created.agentId);
      expect(content?.volumes).toBeUndefined();
    });

    it("should preserve existing custom skills when not provided in update", async () => {
      await createTestZeroSkill(user.orgId, "my-skill");

      // Create with custom skills
      const created = await (
        await postAgent({ customSkills: ["my-skill"] }, testCliToken)
      ).json();

      // Update without customSkills field
      const response = await putAgent(
        created.agentId,
        { displayName: "Updated" },
        testCliToken,
      );
      expect(response.status).toBe(200);

      // Verify skills are preserved
      const getRes = await getAgent(created.agentId, testCliToken);
      const fetched = await getRes.json();
      expect(fetched.customSkills).toEqual(["my-skill"]);
    });

    it("should reject non-existent custom skill names on update", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await putAgent(
        created.agentId,
        { customSkills: ["does-not-exist"] },
        testCliToken,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("does-not-exist");
      expect(data.error.message).toContain("not found");
    });

    it("should reject connector type names as custom skills on update", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await putAgent(
        created.agentId,
        { customSkills: ["github"] },
        testCliToken,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("github");
      expect(data.error.message).toContain("connector");
    });

    it("should return 404 for unknown agent", async () => {
      const response = await putAgent(
        "00000000-0000-0000-0000-000000000000",
        {},
        testCliToken,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("round-trip verification", () => {
    it("should read back agent data after POST via GET", async () => {
      const createRes = await postAgent(
        {
          displayName: "Round Trip Agent",
          description: "test description",
          sound: "friendly",
        },
        testCliToken,
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const getRes = await getAgent(created.agentId, testCliToken);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();

      expect(fetched).toStrictEqual(created);
    });

    it("should read back updated agent data after PUT via GET", async () => {
      const created = await (
        await postAgent({ displayName: "Original" }, testCliToken)
      ).json();

      await putAgent(
        created.agentId,
        {
          displayName: "Updated Name",
          description: "new desc",
          sound: "casual",
        },
        testCliToken,
      );

      const getRes = await getAgent(created.agentId, testCliToken);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();

      expect(fetched.displayName).toBe("Updated Name");
      expect(fetched.description).toBe("new desc");
      expect(fetched.sound).toBe("casual");
    });

    it("should reflect deleted agent in list", async () => {
      const created = await (
        await postAgent({ displayName: "To Delete" }, testCliToken)
      ).json();

      await deleteAgent(created.agentId, testCliToken);

      const listResponse = await listAgentsReq(testCliToken);
      const data = await listResponse.json();
      expect(
        data.find((a: { agentId: string }) => {
          return a.agentId === created.agentId;
        }),
      ).toBeUndefined();
    });
  });

  describe("sandbox token (VM0_TOKEN) access", () => {
    it("should reject GET /api/zero/agents/:name with sandbox token (sandbox tokens have no capabilities)", async () => {
      // Given — create an agent via POST
      const createResponse = await postAgent(
        {
          displayName: "Sandbox Access Agent",
          description: "Agent accessible via sandbox token",
          sound: "professional",
        },
        testCliToken,
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // When — create a run for this agent, then generate a sandbox token
      await createAnthropicModelPolicy(user.orgId);
      const { runId } = await createTestRun(created.agentId, "test prompt");

      // Reset Clerk so sandbox token is the only auth path
      mockClerk({ userId: null });

      const sandboxToken = await createTestSandboxToken(user.userId, runId);

      // Use the sandbox token to GET the agent — should be rejected
      const response = await getAgent(created.agentId, sandboxToken);

      // Then — sandbox tokens can no longer satisfy requiredCapability
      expect(response.status).toBe(403);
    });

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

    it("sandbox token cannot update agent", async () => {
      mockClerk({ userId: null });
      const sandboxToken = await createTestSandboxToken(user.userId, "run-123");

      const response = await putAgent(
        "00000000-0000-0000-0000-000000000000",
        { connectors: [] },
        sandboxToken,
      );
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

  describe("PATCH /api/zero/agents/:name", () => {
    it("should update metadata fields", async () => {
      const created = await (
        await postAgent(
          { displayName: "Original", sound: "professional" },
          testCliToken,
        )
      ).json();

      const response = await patchAgent(
        created.agentId,
        { displayName: "Updated", description: "New desc", sound: "casual" },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Updated");
      expect(data.description).toBe("New desc");
      expect(data.sound).toBe("casual");
      expect(data.agentId).toBe(created.agentId);
      expect(data.ownerId).toBe(user.userId);
    });

    it("should preserve other fields on partial update", async () => {
      const created = await (
        await postAgent(
          {
            displayName: "My Agent",
            description: "A helpful agent",
            sound: "professional",
          },
          testCliToken,
        )
      ).json();

      // Only update displayName
      const response = await patchAgent(
        created.agentId,
        { displayName: "New Name" },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("New Name");
      // Other fields preserved
      expect(data.description).toBe("A helpful agent");
      expect(data.sound).toBe("professional");
    });

    it("should return 404 for unknown agent", async () => {
      const response = await patchAgent(
        "00000000-0000-0000-0000-000000000000",
        { displayName: "X" },
        testCliToken,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should enforce the public limit when switching private to public", async () => {
      const privateAgent = await (
        await postAgent(
          { displayName: "Private", visibility: "private" },
          testCliToken,
        )
      ).json();

      for (let i = 0; i < 7; i++) {
        const response = await postAgent(
          { displayName: `Public ${i + 1}` },
          testCliToken,
        );
        expect(response.status).toBe(201);
      }

      const response = await patchAgent(
        privateAgent.agentId,
        { visibility: "public" },
        testCliToken,
      );
      expect(response.status).toBe(409);
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });
      const response = await patchAgent(
        "00000000-0000-4000-8000-000000000001",
        { displayName: "X" },
        "no-token",
      );
      expect(response.status).toBe(401);
    });
  });

  describe("avatarUrl CRUD", () => {
    it("should set avatarUrl via PATCH and persist it", async () => {
      const created = await (
        await postAgent({ displayName: "AvatarBot" }, testCliToken)
      ).json();

      const patchRes = await patchAgent(
        created.agentId,
        { avatarUrl: "preset:2" },
        testCliToken,
      );
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.avatarUrl).toBe("preset:2");

      // Verify GET returns the same value
      const getRes = await getAgent(created.agentId, testCliToken);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.avatarUrl).toBe("preset:2");
    });

    it("should clear avatarUrl by setting null", async () => {
      const created = await (
        await postAgent({ displayName: "ClearBot" }, testCliToken)
      ).json();

      // Set avatar first
      await patchAgent(
        created.agentId,
        { avatarUrl: "https://example.com/avatar.png" },
        testCliToken,
      );

      // Clear it
      const clearRes = await patchAgent(
        created.agentId,
        { avatarUrl: null },
        testCliToken,
      );
      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.avatarUrl).toBeNull();
    });

    it("should preserve avatarUrl on unrelated partial update", async () => {
      const created = await (
        await postAgent({ displayName: "KeepBot" }, testCliToken)
      ).json();

      // Set avatar
      await patchAgent(
        created.agentId,
        { avatarUrl: "preset:4" },
        testCliToken,
      );

      // Update only displayName — avatarUrl should be preserved
      const patchRes = await patchAgent(
        created.agentId,
        { displayName: "Renamed" },
        testCliToken,
      );
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.displayName).toBe("Renamed");
      expect(patched.avatarUrl).toBe("preset:4");
    });
  });

  describe("DELETE /api/zero/agents/:name", () => {
    it("should delete an agent and return 204", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await deleteAgent(created.agentId, testCliToken);
      expect(response.status).toBe(204);
    });

    it("should return 404 on GET after delete", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      await deleteAgent(created.agentId, testCliToken);

      const getResponse = await getAgent(created.agentId, testCliToken);
      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for nonexistent agent", async () => {
      const response = await deleteAgent(
        "00000000-0000-0000-0000-000000000000",
        testCliToken,
      );
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should delete agent with linked Slack thread sessions", async () => {
      // Create an agent
      const created = await (await postAgent({}, testCliToken)).json();

      // Create an agent session linked to this compose
      const session = await createTestSessionWithConversation(
        user.userId,
        created.agentId,
      );

      // Set up Slack infrastructure
      const orgId = `org_${user.userId.slice(-8)}`;
      const slackWorkspaceId = `T-ws-${user.userId.slice(-8)}`;
      await insertTestSlackOrgInstallation({
        slackWorkspaceId,
        slackWorkspaceName: "Test Workspace",
        orgId,
        installedByUserId: user.userId,
      });
      const connection = await insertTestSlackOrgConnection({
        slackUserId: `U-${user.userId.slice(-8)}`,
        slackWorkspaceId,
        vm0UserId: user.userId,
      });

      // Link Slack thread session to the agent session
      await insertTestSlackOrgThreadSession({
        connectionId: connection.id,
        agentSessionId: session.id,
      });

      // Delete the agent — this would fail with FK constraint before the fix
      const response = await deleteAgent(created.agentId, testCliToken);
      expect(response.status).toBe(204);

      // Verify agent is gone
      const getResponse = await getAgent(created.agentId, testCliToken);
      expect(getResponse.status).toBe(404);
    });

    it("should clean up instructions storage when agent is deleted", async () => {
      const agentName = `cleanup-${user.userId.slice(-8)}`;
      const { composeId } = await createTestCompose(agentName);

      // Create instructions volume for the agent
      const instructionsName = getInstructionsStorageName(agentName);
      await createTestVolume(instructionsName);

      // Verify volume exists
      const storageBefore = await findTestStorageByName(
        user.orgId,
        instructionsName,
      );
      expect(storageBefore).toBeDefined();

      // Mock S3 listing
      context.mocks.s3.listS3Objects.mockResolvedValueOnce([
        {
          key: `${storageBefore!.s3Prefix}/v1/archive.tar.gz`,
          size: 1024,
        },
      ]);

      // Delete agent via zero agents API
      const response = await deleteAgent(composeId, testCliToken);
      expect(response.status).toBe(204);

      // Verify instructions storage cleaned up
      const storageAfter = await findTestStorageByName(
        user.orgId,
        instructionsName,
      );
      expect(storageAfter).toBeUndefined();

      // Verify S3 cleanup called
      expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalled();
    });

    it("should return 409 when agent has running runs", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      // Create a running run for this agent
      await seedTestRun(user.userId, created.agentId, {
        status: "running",
      });

      // Try to delete — should get 409
      const response = await deleteAgent(created.agentId, testCliToken);
      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error.code).toBe("CONFLICT");
    });

    it("should delete runs and preserve usage_event on agent deletion", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const { runId } = await seedTestRun(user.userId, created.agentId, {
        status: "completed",
      });

      const { id: usageEventId } = await insertTestModelUsageEventForRun({
        runId,
        orgId: user.orgId,
        userId: user.userId,
        status: "processed",
        creditsCharged: 100,
      });

      const response = await deleteAgent(created.agentId, testCliToken);
      expect(response.status).toBe(204);

      const run = await findTestRunRecord(runId);
      expect(run).toBeUndefined();

      const usage = await findTestUsageEvent(usageEventId);
      expect(usage).toBeDefined();
      expect(usage!.creditsCharged).toBe(100);
      expect(usage!.status).toBe("processed");
    });

    it("should cascade-delete run data when agent is deleted", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const { runId } = await seedTestRun(user.userId, created.agentId, {
        status: "completed",
      });

      await insertTestSandboxTelemetry({ runId });

      const response = await deleteAgent(created.agentId, testCliToken);
      expect(response.status).toBe(204);

      const run = await findTestRunRecord(runId);
      expect(run).toBeUndefined();

      const telemetry = await findTestSandboxTelemetry(runId);
      expect(telemetry).toBeUndefined();
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });
      const response = await deleteAgent(
        "00000000-0000-4000-8000-000000000001",
        "no-token",
      );
      expect(response.status).toBe(401);
    });

    it("should reject agent run token (agent:delete is agent-excluded)", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      // Switch to zero token auth (agent run) — no Clerk session
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-123", user.orgId);

      const response = await deleteAgent(created.agentId, token);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toBe(
        "Missing required capability: agent:delete",
      );
    });
  });

  describe("invalid UUID handling", () => {
    it("GET should return 400 for invalid UUID", async () => {
      const response = await getAgent("abc", testCliToken);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("PUT should return 400 for invalid UUID", async () => {
      const response = await putAgent("not-a-uuid", {}, testCliToken);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("PATCH should return 400 for invalid UUID", async () => {
      const response = await patchAgent(
        "not-a-uuid",
        { displayName: "X" },
        testCliToken,
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("DELETE should return 400 for invalid UUID", async () => {
      const response = await deleteAgent("not-a-uuid", testCliToken);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("owner/admin permission restriction", () => {
    it("should allow owner to patch default agent metadata even as member", async () => {
      // Create agent as admin — user becomes the owner
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, created.agentId);

      // Re-mock as member and clear cached admin role
      mockClerk({
        userId: user.userId,
        orgId,
        orgRole: "org:member",
        clerkOrgs: [
          {
            id: orgId,
            slug: `org-${user.userId.slice(-8)}`,
            name: `org-${user.userId.slice(-8)}`,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      // Owner can update their own agent even without admin role
      const response = await patchAgent(
        created.agentId,
        { displayName: "Owner Updated" },
        memberToken,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Owner Updated");
    });

    it("should allow admin to patch default agent metadata", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, created.agentId);

      // Admin can still update
      const response = await patchAgent(
        created.agentId,
        { displayName: "Updated by Admin" },
        testCliToken,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Updated by Admin");
    });

    it("should allow owner to patch own non-default agent as member", async () => {
      // Create agent — user is the owner
      const created = await (
        await postAgent({ displayName: "My Agent" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;

      // Re-mock as member and clear cached admin role
      mockClerk({
        userId: user.userId,
        orgId,
        orgRole: "org:member",
        clerkOrgs: [
          {
            id: orgId,
            slug: `org-${user.userId.slice(-8)}`,
            name: `org-${user.userId.slice(-8)}`,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      // Owner can update their own agent
      const response = await patchAgent(
        created.agentId,
        { displayName: "Owner Updated" },
        memberToken,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Owner Updated");
    });

    it("should allow owner to PUT-update default agent as member", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, created.agentId);

      // Re-mock as member and clear cached admin role
      mockClerk({
        userId: user.userId,
        orgId,
        orgRole: "org:member",
        clerkOrgs: [
          {
            id: orgId,
            slug: `org-${user.userId.slice(-8)}`,
            name: `org-${user.userId.slice(-8)}`,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      const response = await putAgent(
        created.agentId,
        { displayName: "Owner PUT Update" },
        memberToken,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Owner PUT Update");
    });

    it("should allow owner to delete default agent as member", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, created.agentId);

      // Re-mock as member and clear cached admin role
      mockClerk({
        userId: user.userId,
        orgId,
        orgRole: "org:member",
        clerkOrgs: [
          {
            id: orgId,
            slug: `org-${user.userId.slice(-8)}`,
            name: `org-${user.userId.slice(-8)}`,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      const response = await deleteAgent(created.agentId, memberToken);
      expect(response.status).toBe(204);
    });

    it("should return 403 when non-owner member patches agent", async () => {
      // User A (admin) creates agent
      const created = await (
        await postAgent({ displayName: "Owned Agent" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;

      // Create User B as a non-owner member of the same org
      const otherUser = await context.setupUser({ prefix: "non-owner" });
      await insertOrgMembersCacheEntry({
        orgId,
        userId: otherUser.userId,
        cachedAt: new Date(),
      });
      mockClerk({ userId: otherUser.userId, orgId, orgRole: "org:member" });
      const otherToken = await createTestCliToken(
        otherUser.userId,
        undefined,
        orgId,
      );

      const response = await patchAgent(
        created.agentId,
        { displayName: "Hacked" },
        otherToken,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 403 when non-owner member PUT-updates agent", async () => {
      // User A (admin) creates agent
      const created = await (
        await postAgent({ displayName: "Owned Agent" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;

      // Create User B as a non-owner member of the same org
      const otherUser = await context.setupUser({ prefix: "non-owner" });
      await insertOrgMembersCacheEntry({
        orgId,
        userId: otherUser.userId,
        cachedAt: new Date(),
      });
      mockClerk({ userId: otherUser.userId, orgId, orgRole: "org:member" });
      const otherToken = await createTestCliToken(
        otherUser.userId,
        undefined,
        orgId,
      );

      const response = await putAgent(
        created.agentId,
        { displayName: "Hacked via PUT" },
        otherToken,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 403 when non-owner member deletes agent", async () => {
      // User A (admin) creates agent
      const created = await (
        await postAgent({ displayName: "Owned Agent" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;

      // Create User B as a non-owner member of the same org
      const otherUser = await context.setupUser({ prefix: "non-owner" });
      await insertOrgMembersCacheEntry({
        orgId,
        userId: otherUser.userId,
        cachedAt: new Date(),
      });
      mockClerk({ userId: otherUser.userId, orgId, orgRole: "org:member" });
      const otherToken = await createTestCliToken(
        otherUser.userId,
        undefined,
        orgId,
      );

      const response = await deleteAgent(created.agentId, otherToken);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should allow admin to update agent owned by another user", async () => {
      // User A (admin) creates agent
      const created = await (
        await postAgent({ displayName: "Admin Owned" }, testCliToken)
      ).json();

      const orgId = `org_mock_${user.userId}`;

      // Create User B and make them an admin of the same org
      const adminUser = await context.setupUser({ prefix: "other-admin" });
      await insertOrgMembersCacheEntry({
        orgId,
        userId: adminUser.userId,
        role: "admin",
        cachedAt: new Date(),
      });
      mockClerk({ userId: adminUser.userId, orgId, orgRole: "org:admin" });
      const adminToken = await createTestCliToken(
        adminUser.userId,
        undefined,
        orgId,
      );

      // Admin B can update agent owned by User A
      const response = await patchAgent(
        created.agentId,
        { displayName: "Admin B Updated" },
        adminToken,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Admin B Updated");
    });

    it("should reject admin visibility changes to public agents owned by another user", async () => {
      const created = await (
        await postAgent({ displayName: "Owner Public" }, testCliToken)
      ).json();

      const adminUser = await context.setupUser({
        prefix: "visibility-admin",
      });
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: adminUser.userId,
        role: "admin",
        cachedAt: new Date(),
      });
      mockClerk({
        userId: adminUser.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });
      const adminToken = await createTestCliToken(
        adminUser.userId,
        undefined,
        user.orgId,
      );

      const response = await patchAgent(
        created.agentId,
        { visibility: "private" },
        adminToken,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent owner");
    });

    it("should reject admin updates to private agents owned by another user", async () => {
      const created = await (
        await postAgent(
          { displayName: "Owner Private", visibility: "private" },
          testCliToken,
        )
      ).json();

      const adminUser = await context.setupUser({ prefix: "private-admin" });
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: adminUser.userId,
        role: "admin",
        cachedAt: new Date(),
      });
      mockClerk({
        userId: adminUser.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });
      const adminToken = await createTestCliToken(
        adminUser.userId,
        undefined,
        user.orgId,
      );

      const response = await patchAgent(
        created.agentId,
        { displayName: "Admin Updated Private" },
        adminToken,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("private agent owner");
    });
  });

  describe("retired agent model fields", () => {
    it("should ignore modelProviderId and selectedModel on PUT", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await putAgent(
        created.agentId,
        {
          modelProviderId: "00000000-0000-4000-8000-000000000001",
          selectedModel: "claude-sonnet-4-6",
        },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.modelProviderId).toBeNull();
      expect(data.selectedModel).toBeNull();
    });

    it("should ignore modelProviderId and selectedModel on PATCH", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await patchAgent(
        created.agentId,
        {
          modelProviderId: "00000000-0000-4000-8000-000000000001",
          selectedModel: "claude-sonnet-4-6",
        },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.modelProviderId).toBeNull();
      expect(data.selectedModel).toBeNull();
    });

    it("should default preferPersonalProvider to false when omitted on POST", async () => {
      const response = await postAgent(
        { displayName: "default-prefer" },
        testCliToken,
      );
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.preferPersonalProvider).toBe(false);
    });

    it("should ignore preferPersonalProvider on PUT", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const response = await putAgent(
        created.agentId,
        { preferPersonalProvider: true },
        testCliToken,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).preferPersonalProvider).toBe(false);
    });

    it("should ignore preferPersonalProvider on PATCH and GET", async () => {
      const created = await (await postAgent({}, testCliToken)).json();

      const patchResponse = await patchAgent(
        created.agentId,
        { preferPersonalProvider: true },
        testCliToken,
      );
      expect(patchResponse.status).toBe(200);
      expect((await patchResponse.json()).preferPersonalProvider).toBe(false);

      const got = await (await getAgent(created.agentId, testCliToken)).json();
      expect(got.preferPersonalProvider).toBe(false);
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
