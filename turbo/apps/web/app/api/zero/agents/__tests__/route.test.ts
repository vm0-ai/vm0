import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { POST, GET as listAgents } from "../route";
import { GET, PUT, PATCH, DELETE } from "../[id]/route";
import {
  GET as getInstructions,
  PUT as putInstructions,
} from "../[id]/instructions/route";
import {
  createTestRequest,
  createTestCliToken,
  createTestCompose,
  createTestRun,
  createTestRunInDb,
  createTestOrgModelProvider,
  createTestSandboxToken,
  createTestVolume,
  findTestStorageByName,
  seedSeedSkills,
  seedSeedSkillStorages,
  clearSkillsData,
  createTestSchedule,
  enableTestSchedule,
  createTestSessionWithConversation,
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
  insertTestSlackOrgPendingQuestion,
  setDefaultAgentByComposeId,
  clearOrgMembersCacheEntry,
  getTestComposeVersionContent,
} from "../../../../../src/__tests__/api-test-helpers";
import { getInstructionsStorageName } from "@vm0/core";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { createSingleFileTar } from "../../../../../src/lib/tar";
import { POST as runSchedule } from "../../schedules/run/route";

const context = testContext();

let user: UserContext;
let testCliToken: string;
let testOrgSlug: string;

function postAgent(
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return POST(
    createTestRequest(`http://localhost:3000/api/zero/agents${orgParam}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getAgent(name: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putAgent(
  name: string,
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function patchAgent(
  name: string,
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return PATCH(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function listAgentsReq(token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return listAgents(
    createTestRequest(`http://localhost:3000/api/zero/agents${orgParam}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

function deleteAgent(name: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return DELETE(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function getAgentInstructions(name: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return getInstructions(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}/instructions${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putAgentInstructions(
  name: string,
  body: { content: string },
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return putInstructions(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}/instructions${orgParam}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

describe("Zero Agents API", () => {
  beforeEach(async () => {
    context.setupMocks();
    await clearSkillsData();
    await seedSeedSkills();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
    testOrgSlug = `org-${user.userId.slice(-8)}`;
  });

  describe("POST /api/zero/agents", () => {
    it("should create an agent", async () => {
      const response = await postAgent({}, testCliToken, testOrgSlug);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.agentId).toBeTruthy();
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
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.displayName).toBe("My Agent");
      expect(data.description).toBe("A helpful agent");
      expect(data.sound).toBe("professional");
    });

    it("should create an agent with connector env var templates in compose", async () => {
      const response = await postAgent({}, testCliToken, testOrgSlug);

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

    it("should create an agent with custom skills and include them in response and compose", async () => {
      const response = await postAgent(
        { customSkills: ["my-skill", "data-tool"] },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.customSkills).toEqual(["my-skill", "data-tool"]);

      // Verify compose content includes custom skill volumes
      const content = await getTestComposeVersionContent(data.agentId);
      const volumes = content?.volumes as
        | Record<string, { name: string; version: string }>
        | undefined;
      expect(volumes?.["custom-skill-my-skill"]).toEqual({
        name: "custom-skill@my-skill",
        version: "latest",
      });
      expect(volumes?.["custom-skill-data-tool"]).toEqual({
        name: "custom-skill@data-tool",
        version: "latest",
      });
    });

    it("should return 422 when skills are not cached", async () => {
      await clearSkillsData();

      const response = await postAgent({}, testCliToken, testOrgSlug);

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error.code).toBe("UNPROCESSABLE_ENTITY");
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });

      const response = await postAgent({}, "no-token");
      expect(response.status).toBe(401);
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
        testOrgSlug,
      );

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Get the agent
      const response = await getAgent(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agentId).toBe(created.agentId);
      expect(data.displayName).toBe("Test Agent");
      expect(data.description).toBe("Test description");
      expect(data.sound).toBe("friendly");
    });

    it("should return 404 for unknown agent", async () => {
      const response = await getAgent(
        "00000000-0000-0000-0000-000000000000",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("PUT /api/zero/agents/:name", () => {
    it("should update agent metadata", async () => {
      // Create an agent first
      const createResponse = await postAgent(
        { displayName: "Original" },
        testCliToken,
        testOrgSlug,
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
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
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
        testOrgSlug,
      );
      const created = await createResponse.json();

      // Update with no metadata fields
      const updateResponse = await putAgent(
        created.agentId,
        {},
        testCliToken,
        testOrgSlug,
      );
      expect(updateResponse.status).toBe(200);

      // Verify metadata is preserved
      const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.displayName).toBe("My Agent");
      expect(fetched.description).toBe("A helpful agent");
      expect(fetched.sound).toBe("professional");
    });

    it("should rebuild compose with connector env var templates", async () => {
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

      const response = await putAgent(
        created.agentId,
        { displayName: "Refreshed" },
        testCliToken,
        testOrgSlug,
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

    it("should update custom skills and reflect in compose volumes", async () => {
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

      const response = await putAgent(
        created.agentId,
        { customSkills: ["my-skill", "data-tool"] },
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(200);

      // Verify skills are persisted
      const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
      const fetched = await getRes.json();
      expect(fetched.customSkills).toEqual(["my-skill", "data-tool"]);

      // Verify compose content includes custom skill volumes
      const content = await getTestComposeVersionContent(created.agentId);
      const volumes = content?.volumes as
        | Record<string, { name: string; version: string }>
        | undefined;
      expect(volumes?.["custom-skill-my-skill"]).toEqual({
        name: "custom-skill@my-skill",
        version: "latest",
      });
    });

    it("should preserve existing custom skills when not provided in update", async () => {
      // Create with custom skills
      const created = await (
        await postAgent(
          { customSkills: ["my-skill"] },
          testCliToken,
          testOrgSlug,
        )
      ).json();

      // Update without customSkills field
      const response = await putAgent(
        created.agentId,
        { displayName: "Updated" },
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(200);

      // Verify skills are preserved
      const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
      const fetched = await getRes.json();
      expect(fetched.customSkills).toEqual(["my-skill"]);
    });

    it("should return 404 for unknown agent", async () => {
      const response = await putAgent(
        "00000000-0000-0000-0000-000000000000",
        {},
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/zero/agents/:name/instructions", () => {
    it("should return null content when no instructions uploaded", async () => {
      const createResponse = await postAgent({}, testCliToken, testOrgSlug);
      const created = await createResponse.json();

      const response = await getAgentInstructions(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBeNull();
    });

    it("should return 404 for unknown agent", async () => {
      const response = await getAgentInstructions(
        "00000000-0000-0000-0000-000000000000",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/zero/agents/:name/instructions", () => {
    it("should update instructions and return agent response", async () => {
      const createResponse = await postAgent({}, testCliToken, testOrgSlug);
      const created = await createResponse.json();

      const response = await putAgentInstructions(
        created.agentId,
        { content: "# Updated Instructions\nBe helpful." },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agentId).toBe(created.agentId);
    });

    it("should rebuild compose with connector env var templates", async () => {
      const createResponse = await postAgent({}, testCliToken, testOrgSlug);
      const created = await createResponse.json();

      // Update instructions
      const response = await putAgentInstructions(
        created.agentId,
        { content: "# New instructions" },
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(200);

      // Verify compose was rebuilt with connector env var templates
      const content = await getTestComposeVersionContent(created.agentId);
      const agents = content?.agents as Record<
        string,
        { environment: Record<string, string> }
      >;
      const agentEnv = Object.values(agents)[0]!.environment;

      // GA connector env vars should be present (GitHub is GA)
      expect(agentEnv.GH_TOKEN).toBe("${{ secrets.GH_TOKEN }}");
      expect(agentEnv.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
      // Base env vars still present
      expect(agentEnv.ZERO_AGENT_ID).toBe("${{ vars.ZERO_AGENT_ID }}");
      expect(agentEnv.ZERO_TOKEN).toBe("${{ secrets.ZERO_TOKEN }}");
    });

    it("should return 404 for unknown agent", async () => {
      const response = await putAgentInstructions(
        "00000000-0000-0000-0000-000000000000",
        { content: "# Instructions" },
        testCliToken,
        testOrgSlug,
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
        testOrgSlug,
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();

      expect(fetched).toStrictEqual(created);
    });

    it("should read back updated agent data after PUT via GET", async () => {
      const created = await (
        await postAgent({ displayName: "Original" }, testCliToken, testOrgSlug)
      ).json();

      await putAgent(
        created.agentId,
        {
          displayName: "Updated Name",
          description: "new desc",
          sound: "casual",
        },
        testCliToken,
        testOrgSlug,
      );

      const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();

      expect(fetched.displayName).toBe("Updated Name");
      expect(fetched.description).toBe("new desc");
      expect(fetched.sound).toBe("casual");
    });

    it("should reflect deleted agent in list", async () => {
      const created = await (
        await postAgent({ displayName: "To Delete" }, testCliToken, testOrgSlug)
      ).json();

      await deleteAgent(created.agentId, testCliToken, testOrgSlug);

      const listResponse = await listAgentsReq(testCliToken, testOrgSlug);
      const data = await listResponse.json();
      expect(
        data.find((a: { agentId: string }) => a.agentId === created.agentId),
      ).toBeUndefined();
    });

    it("should read back instructions content after PUT via GET", async () => {
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

      const instructionsContent = "# My Instructions\nBe helpful.";
      await putAgentInstructions(
        created.agentId,
        { content: instructionsContent },
        testCliToken,
        testOrgSlug,
      );

      // Mock S3 downloads to return what was uploaded
      const canonicalFilename = "CLAUDE.md";
      context.mocks.s3.downloadManifest.mockResolvedValueOnce({
        version: "a".repeat(64),
        createdAt: new Date().toISOString(),
        totalSize: instructionsContent.length,
        fileCount: 1,
        files: [
          {
            path: canonicalFilename,
            hash: "b".repeat(64),
            size: instructionsContent.length,
          },
        ],
      });
      context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
        gzipSync(
          createSingleFileTar(
            canonicalFilename,
            Buffer.from(instructionsContent, "utf-8"),
          ),
        ),
      );

      const getRes = await getAgentInstructions(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();

      expect(fetched.content).toBe(instructionsContent);
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
        testOrgSlug,
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // When — create a run for this agent, then generate a sandbox token
      await createTestOrgModelProvider("anthropic-api-key", "test-key");
      const { runId } = await createTestRun(created.agentId, "test prompt");

      // Reset Clerk so sandbox token is the only auth path
      mockClerk({ userId: null });

      const sandboxToken = await createTestSandboxToken(user.userId, runId);

      // Use the sandbox token to GET the agent — should be rejected
      const response = await getAgent(
        created.agentId,
        sandboxToken,
        testOrgSlug,
      );

      // Then — sandbox tokens can no longer satisfy requiredCapability
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/zero/agents", () => {
    it("should return empty array when no agents exist", async () => {
      const response = await listAgentsReq(testCliToken, testOrgSlug);
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
          testOrgSlug,
        )
      ).json();

      const response = await listAgentsReq(testCliToken, testOrgSlug);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].agentId).toBe(created.agentId);
      expect(data[0].displayName).toBe("Listed Agent");
      expect(data[0].description).toBe("desc");
      expect(data[0].sound).toBe("friendly");
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });
      const response = await listAgentsReq("no-token");
      expect(response.status).toBe(401);
    });
  });

  describe("PATCH /api/zero/agents/:name", () => {
    it("should update metadata fields", async () => {
      const created = await (
        await postAgent(
          { displayName: "Original", sound: "professional" },
          testCliToken,
          testOrgSlug,
        )
      ).json();

      const response = await patchAgent(
        created.agentId,
        { displayName: "Updated", description: "New desc", sound: "casual" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Updated");
      expect(data.description).toBe("New desc");
      expect(data.sound).toBe("casual");
      expect(data.agentId).toBe(created.agentId);
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
          testOrgSlug,
        )
      ).json();

      // Only update displayName
      const response = await patchAgent(
        created.agentId,
        { displayName: "New Name" },
        testCliToken,
        testOrgSlug,
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
        testOrgSlug,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
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
        await postAgent({ displayName: "AvatarBot" }, testCliToken, testOrgSlug)
      ).json();

      const patchRes = await patchAgent(
        created.agentId,
        { avatarUrl: "preset:2" },
        testCliToken,
        testOrgSlug,
      );
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.avatarUrl).toBe("preset:2");

      // Verify GET returns the same value
      const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.avatarUrl).toBe("preset:2");
    });

    it("should clear avatarUrl by setting null", async () => {
      const created = await (
        await postAgent({ displayName: "ClearBot" }, testCliToken, testOrgSlug)
      ).json();

      // Set avatar first
      await patchAgent(
        created.agentId,
        { avatarUrl: "https://example.com/avatar.png" },
        testCliToken,
        testOrgSlug,
      );

      // Clear it
      const clearRes = await patchAgent(
        created.agentId,
        { avatarUrl: null },
        testCliToken,
        testOrgSlug,
      );
      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.avatarUrl).toBeNull();
    });

    it("should preserve avatarUrl on unrelated partial update", async () => {
      const created = await (
        await postAgent({ displayName: "KeepBot" }, testCliToken, testOrgSlug)
      ).json();

      // Set avatar
      await patchAgent(
        created.agentId,
        { avatarUrl: "preset:4" },
        testCliToken,
        testOrgSlug,
      );

      // Update only displayName — avatarUrl should be preserved
      const patchRes = await patchAgent(
        created.agentId,
        { displayName: "Renamed" },
        testCliToken,
        testOrgSlug,
      );
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.displayName).toBe("Renamed");
      expect(patched.avatarUrl).toBe("preset:4");
    });
  });

  describe("DELETE /api/zero/agents/:name", () => {
    it("should delete an agent and return 204", async () => {
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

      const response = await deleteAgent(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(204);
    });

    it("should return 404 on GET after delete", async () => {
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

      await deleteAgent(created.agentId, testCliToken, testOrgSlug);

      const getResponse = await getAgent(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );
      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for nonexistent agent", async () => {
      const response = await deleteAgent(
        "00000000-0000-0000-0000-000000000000",
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should delete agent with linked Slack thread sessions and pending questions", async () => {
      // Create an agent
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

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

      // Create a pending question referencing both compose and session
      await insertTestSlackOrgPendingQuestion({
        connectionId: connection.id,
        composeId: created.agentId,
        sessionId: session.id,
        runId: `run-${user.userId.slice(-8)}`,
        slackWorkspaceId,
      });

      // Delete the agent — this would fail with FK constraint before the fix
      const response = await deleteAgent(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(204);

      // Verify agent is gone
      const getResponse = await getAgent(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );
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
      const response = await deleteAgent(composeId, testCliToken, testOrgSlug);
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
      const created = await (
        await postAgent({}, testCliToken, testOrgSlug)
      ).json();

      // Create a running run for this agent
      await createTestRunInDb(user.userId, created.agentId, {
        status: "running",
      });

      // Try to delete — should get 409
      const response = await deleteAgent(
        created.agentId,
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error.code).toBe("CONFLICT");
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });
      const response = await deleteAgent(
        "00000000-0000-4000-8000-000000000001",
        "no-token",
      );
      expect(response.status).toBe(401);
    });
  });

  describe("invalid UUID handling", () => {
    it("GET should return 400 for invalid UUID", async () => {
      const response = await getAgent("abc", testCliToken, testOrgSlug);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("PUT should return 400 for invalid UUID", async () => {
      const response = await putAgent(
        "not-a-uuid",
        {},
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("PATCH should return 400 for invalid UUID", async () => {
      const response = await patchAgent(
        "not-a-uuid",
        { displayName: "X" },
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("DELETE should return 400 for invalid UUID", async () => {
      const response = await deleteAgent(
        "not-a-uuid",
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("GET instructions should return 400 for invalid UUID", async () => {
      const response = await getAgentInstructions(
        "not-a-uuid",
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("PUT instructions should return 400 for invalid UUID", async () => {
      const response = await putAgentInstructions(
        "not-a-uuid",
        { content: "# test" },
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("default agent admin restriction", () => {
    it("should return 403 when member patches default agent metadata", async () => {
      // Create agent as admin
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken, testOrgSlug)
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
            slug: testOrgSlug,
            name: testOrgSlug,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      const response = await patchAgent(
        created.agentId,
        { displayName: "Hacked" },
        memberToken,
        testOrgSlug,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 403 when member updates default agent instructions", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken, testOrgSlug)
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
            slug: testOrgSlug,
            name: testOrgSlug,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      const response = await putAgentInstructions(
        created.agentId,
        { content: "# Hacked instructions" },
        memberToken,
        testOrgSlug,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should allow admin to patch default agent metadata", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken, testOrgSlug)
      ).json();

      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, created.agentId);

      // Admin can still update
      const response = await patchAgent(
        created.agentId,
        { displayName: "Updated by Admin" },
        testCliToken,
        testOrgSlug,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Updated by Admin");
    });

    it("should allow member to patch non-default agent metadata", async () => {
      // Create two agents — mark only one as default
      const defaultAgent = await (
        await postAgent({ displayName: "Default" }, testCliToken, testOrgSlug)
      ).json();
      const otherAgent = await (
        await postAgent({ displayName: "Other" }, testCliToken, testOrgSlug)
      ).json();

      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, defaultAgent.agentId);

      // Re-mock as member and clear cached admin role
      mockClerk({
        userId: user.userId,
        orgId,
        orgRole: "org:member",
        clerkOrgs: [
          {
            id: orgId,
            slug: testOrgSlug,
            name: testOrgSlug,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      // Member can update non-default agent
      const response = await patchAgent(
        otherAgent.agentId,
        { displayName: "Member Updated" },
        memberToken,
        testOrgSlug,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Member Updated");
    });

    it("should return 403 when member PUT-updates default agent", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken, testOrgSlug)
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
            slug: testOrgSlug,
            name: testOrgSlug,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      const response = await putAgent(
        created.agentId,
        { displayName: "Hacked via PUT" },
        memberToken,
        testOrgSlug,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 403 when member deletes default agent", async () => {
      const created = await (
        await postAgent({ displayName: "Default" }, testCliToken, testOrgSlug)
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
            slug: testOrgSlug,
            name: testOrgSlug,
            role: "org:member",
          },
        ],
      });
      await clearOrgMembersCacheEntry(orgId, user.userId);
      const memberToken = await createTestCliToken(user.userId);

      const response = await deleteAgent(
        created.agentId,
        memberToken,
        testOrgSlug,
      );
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });
  });

  describe("schedule run integration", () => {
    it("should execute schedule for agent created via POST /api/zero/agents", async () => {
      // Regression: serverSideCompose was called without instructions param,
      // so agent-instructions storage was never created. Schedule runs then
      // failed with "Storage agent-instructions@<id> not found".
      await seedSeedSkillStorages();
      await createTestOrgModelProvider("anthropic-api-key", "test-key");

      // 1. Create agent via POST /api/zero/agents
      const createResponse = await postAgent(
        { displayName: "Schedule Bug Agent" },
        testCliToken,
        testOrgSlug,
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
        createTestRequest(
          `http://localhost:3000/api/zero/schedules/run?org=${testOrgSlug}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduleId: schedule.id }),
          },
        ),
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
    });
  });
});
