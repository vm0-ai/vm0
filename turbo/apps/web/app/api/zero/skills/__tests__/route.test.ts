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
  bindCustomSkillToAgent,
  seedTestCompose,
  getAgentCustomSkills,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { createSingleFileTar } from "../../../../../src/lib/tar";

const context = testContext();

let user: UserContext;
let testCliToken: string;

function postSkillReq(body: Record<string, unknown>, token: string) {
  return postSkill(
    createTestRequest(`http://localhost:3000/api/zero/skills`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function listSkillsReq(token: string) {
  return listSkills(
    createTestRequest(`http://localhost:3000/api/zero/skills`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

function getSkillReq(name: string, token: string) {
  return getSkill(
    createTestRequest(`http://localhost:3000/api/zero/skills/${name}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

function putSkillReq(
  name: string,
  body: Record<string, unknown>,
  token: string,
) {
  return putSkill(
    createTestRequest(`http://localhost:3000/api/zero/skills/${name}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function deleteSkillReq(name: string, token: string) {
  return deleteSkill(
    createTestRequest(`http://localhost:3000/api/zero/skills/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
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

describe("Zero Skills API (org-level)", () => {
  beforeEach(async () => {
    context.setupMocks();
    await seedSeedSkills();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
  });

  describe("POST /api/zero/skills", () => {
    it("should create a skill and return 201", async () => {
      const response = await postSkillReq(
        { name: "my-skill", content: "# My Skill\nHello" },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.displayName).toBeNull();
      expect(data.description).toBeNull();
    });

    it("should create a skill with metadata", async () => {
      const response = await postSkillReq(
        {
          name: "my-skill",
          content: "# Content",
          displayName: "My Skill",
          description: "A useful skill",
        },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.displayName).toBe("My Skill");
      expect(data.description).toBe("A useful skill");
    });

    it("should not bind skill to any agent", async () => {
      const orgId = `org_mock_${user.userId}`;
      const { agentId } = await seedTestCompose({
        userId: user.userId,
        name: `test-agent-${user.userId.slice(-8)}`,
        orgId,
      });

      await postSkillReq(
        { name: "unbound-skill", content: "# Content" },
        testCliToken,
      );

      // Verify skill exists in org list
      const listRes = await listSkillsReq(testCliToken);
      const skills = await listRes.json();
      expect(
        skills.some((s: { name: string }) => s.name === "unbound-skill"),
      ).toBe(true);

      // Verify agent's customSkills is still empty after skill creation
      const agentSkills = await getAgentCustomSkills(agentId);
      expect(agentSkills).toEqual([]);
    });

    it("should reject duplicate skill name with 409", async () => {
      await postSkillReq(
        { name: "my-skill", content: "# Content" },
        testCliToken,
      );

      const response = await postSkillReq(
        { name: "my-skill", content: "# Other" },
        testCliToken,
      );

      expect(response.status).toBe(409);
    });

    it("should reject seed skill name with 409", async () => {
      const response = await postSkillReq(
        { name: "deep-dive", content: "# Content" },
        testCliToken,
      );

      expect(response.status).toBe(409);
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });

      const response = await postSkillReq(
        { name: "my-skill", content: "# Content" },
        "no-token",
      );

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/zero/skills", () => {
    it("should return empty array when no skills", async () => {
      const response = await listSkillsReq(testCliToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual([]);
    });

    it("should return all org skills", async () => {
      await postSkillReq(
        {
          name: "skill-one",
          content: "# One",
          displayName: "Skill One",
          description: "First skill",
        },
        testCliToken,
      );
      await postSkillReq({ name: "skill-two", content: "# Two" }, testCliToken);

      const response = await listSkillsReq(testCliToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(2);

      const names = data.map((s: { name: string }) => s.name);
      expect(names).toContain("skill-one");
      expect(names).toContain("skill-two");
    });
  });

  describe("GET /api/zero/skills/:name", () => {
    it("should return skill with content", async () => {
      await postSkillReq(
        {
          name: "my-skill",
          content: "# My Skill Content",
          displayName: "My Skill",
        },
        testCliToken,
      );

      mockSkillContent("# My Skill Content");

      const response = await getSkillReq("my-skill", testCliToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.displayName).toBe("My Skill");
      expect(data.content).toBe("# My Skill Content");
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await getSkillReq("no-such-skill", testCliToken);

      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/zero/skills/:name", () => {
    it("should update skill content", async () => {
      await postSkillReq(
        { name: "my-skill", content: "# Original" },
        testCliToken,
      );

      const response = await putSkillReq(
        "my-skill",
        { content: "# Updated Content" },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.content).toBe("# Updated Content");
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await putSkillReq(
        "no-such-skill",
        { content: "# Content" },
        testCliToken,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/zero/skills/:name", () => {
    it("should delete skill and return 204", async () => {
      await postSkillReq(
        { name: "my-skill", content: "# Content" },
        testCliToken,
      );

      const response = await deleteSkillReq("my-skill", testCliToken);

      expect(response.status).toBe(204);

      // Verify skill is removed from list
      const listRes = await listSkillsReq(testCliToken);
      const data = await listRes.json();
      expect(data).toEqual([]);
    });

    it("should unbind skill from all agents on delete", async () => {
      // Create skill
      await postSkillReq(
        { name: "shared-skill", content: "# Shared" },
        testCliToken,
      );

      // Bind to two agents
      const orgId = `org_mock_${user.userId}`;
      const agent1 = await seedTestCompose({
        userId: user.userId,
        name: `agent1-${user.userId.slice(-8)}`,
        orgId,
      });
      const agent2 = await seedTestCompose({
        userId: user.userId,
        name: `agent2-${user.userId.slice(-8)}`,
        orgId,
      });
      await bindCustomSkillToAgent(agent1.agentId, "shared-skill");
      await bindCustomSkillToAgent(agent2.agentId, "shared-skill");

      // Delete the skill at org level
      const response = await deleteSkillReq("shared-skill", testCliToken);

      expect(response.status).toBe(204);

      // Verify skill is gone from org
      const listRes = await listSkillsReq(testCliToken);
      const data = await listRes.json();
      expect(data).toEqual([]);
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await deleteSkillReq("no-such-skill", testCliToken);

      expect(response.status).toBe(404);
    });
  });
});
