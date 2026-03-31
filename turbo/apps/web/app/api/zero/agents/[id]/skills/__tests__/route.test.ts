import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { POST as postSkill, GET as listSkills } from "../route";
import {
  GET as getSkill,
  PUT as putSkill,
  DELETE as deleteSkill,
} from "../[name]/route";
import {
  createTestRequest,
  createTestCliToken,
  seedSeedSkills,
  setDefaultAgentByComposeId,
  clearOrgMembersCacheEntry,
  bindCustomSkillToAgent,
  seedTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { createSingleFileTar } from "../../../../../../../src/lib/tar";

const context = testContext();

let user: UserContext;
let testCliToken: string;
let testOrgSlug: string;
let agentId: string;

function postSkillReq(
  agentId: string,
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return postSkill(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/skills${orgParam}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function listSkillsReq(agentId: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return listSkills(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/skills${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function getSkillReq(
  agentId: string,
  name: string,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return getSkill(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/skills/${name}${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putSkillReq(
  agentId: string,
  name: string,
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return putSkill(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/skills/${name}${orgParam}`,
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

function deleteSkillReq(
  agentId: string,
  name: string,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return deleteSkill(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/skills/${name}${orgParam}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function mockSkillContent(content: string) {
  const tarBuffer = createSingleFileTar(
    "SKILL.md",
    Buffer.from(content, "utf-8"),
  );
  const gzipped = gzipSync(tarBuffer);

  context.mocks.s3.downloadManifest.mockResolvedValueOnce({
    version: "test-version",
    createdAt: new Date().toISOString(),
    totalSize: content.length,
    fileCount: 1,
    files: [{ path: "SKILL.md", hash: "testhash", size: content.length }],
  });
  context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(gzipped);
}

describe("Zero Agent Skills API", () => {
  beforeEach(async () => {
    context.setupMocks();
    // Seed skills table for serverSideCompose (uses onConflictDoNothing)
    await seedSeedSkills();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
    testOrgSlug = `org-${user.userId.slice(-8)}`;

    // Seed agent directly in DB to avoid API-level serverSideCompose call
    // during setup (reduces exposure to parallel test interference).
    const orgId = `org_mock_${user.userId}`;
    const result = await seedTestCompose({
      userId: user.userId,
      name: `test-agent-${user.userId.slice(-8)}`,
      orgId,
    });
    agentId = result.agentId;
  });

  describe("POST /api/zero/agents/:id/skills", () => {
    it("should create a skill and return 201", async () => {
      const response = await postSkillReq(
        agentId,
        { name: "my-skill", content: "# My Skill\nHello" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.displayName).toBeNull();
      expect(data.description).toBeNull();
    });

    it("should create a skill with metadata", async () => {
      const response = await postSkillReq(
        agentId,
        {
          name: "my-skill",
          content: "# Content",
          displayName: "My Skill",
          description: "A useful skill",
        },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.displayName).toBe("My Skill");
      expect(data.description).toBe("A useful skill");
    });

    it("should reject duplicate skill name with 409", async () => {
      await postSkillReq(
        agentId,
        { name: "my-skill", content: "# Content" },
        testCliToken,
        testOrgSlug,
      );

      const response = await postSkillReq(
        agentId,
        { name: "my-skill", content: "# Other" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(409);
    });

    it("should reject seed skill name with 409", async () => {
      const response = await postSkillReq(
        agentId,
        { name: "deep-dive", content: "# Content" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(409);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const response = await postSkillReq(
        fakeId,
        { name: "my-skill", content: "# Content" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });

      const response = await postSkillReq(
        agentId,
        { name: "my-skill", content: "# Content" },
        "no-token",
      );

      expect(response.status).toBe(401);
    });

    it("should return 403 for non-admin on default agent", async () => {
      const orgId = `org_mock_${user.userId}`;
      await setDefaultAgentByComposeId(orgId, agentId);

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

      const response = await postSkillReq(
        agentId,
        { name: "my-skill", content: "# Content" },
        memberToken,
        testOrgSlug,
      );

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/zero/agents/:id/skills", () => {
    it("should return empty array when no skills", async () => {
      const response = await listSkillsReq(agentId, testCliToken, testOrgSlug);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual([]);
    });

    it("should return created skills", async () => {
      await postSkillReq(
        agentId,
        {
          name: "skill-one",
          content: "# One",
          displayName: "Skill One",
          description: "First skill",
        },
        testCliToken,
        testOrgSlug,
      );
      await postSkillReq(
        agentId,
        { name: "skill-two", content: "# Two" },
        testCliToken,
        testOrgSlug,
      );

      const response = await listSkillsReq(agentId, testCliToken, testOrgSlug);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(2);

      const names = data.map((s: { name: string }) => s.name);
      expect(names).toContain("skill-one");
      expect(names).toContain("skill-two");
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const response = await listSkillsReq(fakeId, testCliToken, testOrgSlug);

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/zero/agents/:id/skills/:name", () => {
    it("should return skill with content", async () => {
      await postSkillReq(
        agentId,
        {
          name: "my-skill",
          content: "# My Skill Content",
          displayName: "My Skill",
        },
        testCliToken,
        testOrgSlug,
      );

      mockSkillContent("# My Skill Content");

      const response = await getSkillReq(
        agentId,
        "my-skill",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.displayName).toBe("My Skill");
      expect(data.content).toBe("# My Skill Content");
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await getSkillReq(
        agentId,
        "no-such-skill",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/zero/agents/:id/skills/:name", () => {
    it("should update skill content", async () => {
      await postSkillReq(
        agentId,
        { name: "my-skill", content: "# Original" },
        testCliToken,
        testOrgSlug,
      );

      const response = await putSkillReq(
        agentId,
        "my-skill",
        { content: "# Updated Content" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.content).toBe("# Updated Content");
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await putSkillReq(
        agentId,
        "no-such-skill",
        { content: "# Content" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/zero/agents/:id/skills/:name", () => {
    it("should delete skill and return 204", async () => {
      await postSkillReq(
        agentId,
        { name: "my-skill", content: "# Content" },
        testCliToken,
        testOrgSlug,
      );

      const response = await deleteSkillReq(
        agentId,
        "my-skill",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(204);

      // Verify skill is removed from list
      const listRes = await listSkillsReq(agentId, testCliToken, testOrgSlug);
      const data = await listRes.json();
      expect(data).toEqual([]);
    });

    it("should keep skill in DB when another agent references it", async () => {
      // Create skill on first agent
      await postSkillReq(
        agentId,
        { name: "shared-skill", content: "# Shared" },
        testCliToken,
        testOrgSlug,
      );

      // Create second agent directly in DB
      const orgId = `org_mock_${user.userId}`;
      const result2 = await seedTestCompose({
        userId: user.userId,
        name: `test-agent2-${user.userId.slice(-8)}`,
        orgId,
      });
      const agent2Id = result2.agentId;

      // Bind the existing skill to agent2
      await bindCustomSkillToAgent(agent2Id, "shared-skill");

      // Delete from first agent
      await deleteSkillReq(agentId, "shared-skill", testCliToken, testOrgSlug);

      // Skill should still be accessible on second agent (not deleted from zero_skills)
      const listRes = await listSkillsReq(agent2Id, testCliToken, testOrgSlug);
      const data = await listRes.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("shared-skill");
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await deleteSkillReq(
        agentId,
        "no-such-skill",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });
});
