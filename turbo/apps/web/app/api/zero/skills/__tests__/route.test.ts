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
  createTestCompose,
  bindCustomSkillToAgent,
  getAgentCustomSkills,
  insertOrgMembersCacheEntry,
  createTestTarFile,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

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

function singleFile(content: string) {
  return [{ path: "SKILL.md", content }];
}

function mockSkillContent(
  content: string,
  extraFiles?: Array<{ path: string; size: number }>,
) {
  const tarBuffer = createTestTarFile(
    "SKILL.md",
    Buffer.from(content, "utf-8"),
  );
  const gzipped = gzipSync(tarBuffer);

  const files = [
    { path: "SKILL.md", hash: "testhash", size: content.length },
    ...(extraFiles ?? []).map((f) => {
      return { ...f, hash: "extrahash" };
    }),
  ];

  context.mocks.s3.downloadManifest.mockResolvedValueOnce({
    version: "test-version",
    createdAt: new Date().toISOString(),
    totalSize: files.reduce((sum, f) => {
      return sum + f.size;
    }, 0),
    fileCount: files.length,
    files,
  });
  context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(gzipped);
}

describe("Zero Skills API (org-level)", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
  });

  describe("POST /api/zero/skills", () => {
    it("should create a skill and return 201", async () => {
      const response = await postSkillReq(
        { name: "my-skill", files: singleFile("# My Skill\nHello") },
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
          files: singleFile("# Content"),
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
      const { agentId } = await createTestCompose(
        `test-agent-${user.userId.slice(-8)}`,
      );

      await postSkillReq(
        { name: "unbound-skill", files: singleFile("# Content") },
        testCliToken,
      );

      // Verify skill exists in org list
      const listRes = await listSkillsReq(testCliToken);
      const skills = await listRes.json();
      expect(
        skills.some((s: { name: string }) => {
          return s.name === "unbound-skill";
        }),
      ).toBe(true);

      // Verify agent's customSkills is still empty after skill creation
      const agentSkills = await getAgentCustomSkills(agentId);
      expect(agentSkills).toEqual([]);
    });

    it("should reject duplicate skill name with 409", async () => {
      await postSkillReq(
        { name: "my-skill", files: singleFile("# Content") },
        testCliToken,
      );

      const response = await postSkillReq(
        { name: "my-skill", files: singleFile("# Other") },
        testCliToken,
      );

      expect(response.status).toBe(409);
    });

    it("should reject seed skill name with 409", async () => {
      const response = await postSkillReq(
        { name: "deep-dive", files: singleFile("# Content") },
        testCliToken,
      );

      expect(response.status).toBe(409);
    });

    it("should return 401 without auth", async () => {
      mockClerk({ userId: null });

      const response = await postSkillReq(
        { name: "my-skill", files: singleFile("# Content") },
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
          files: singleFile("# One"),
          displayName: "Skill One",
          description: "First skill",
        },
        testCliToken,
      );
      await postSkillReq(
        { name: "skill-two", files: singleFile("# Two") },
        testCliToken,
      );

      const response = await listSkillsReq(testCliToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(2);

      const names = data.map((s: { name: string }) => {
        return s.name;
      });
      expect(names).toContain("skill-one");
      expect(names).toContain("skill-two");
    });
  });

  describe("GET /api/zero/skills/:name", () => {
    it("should return skill with content", async () => {
      await postSkillReq(
        {
          name: "my-skill",
          files: singleFile("# My Skill Content"),
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
      expect(data.files).toEqual([{ path: "SKILL.md", size: 18 }]);
    });

    it("should return file listing for multi-file skill", async () => {
      await postSkillReq(
        { name: "multi-skill", files: singleFile("# Multi") },
        testCliToken,
      );

      mockSkillContent("# Multi", [{ path: "templates/prompt.md", size: 42 }]);

      const response = await getSkillReq("multi-skill", testCliToken);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.files).toEqual([
        { path: "SKILL.md", size: 7 },
        { path: "templates/prompt.md", size: 42 },
      ]);
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await getSkillReq("no-such-skill", testCliToken);

      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/zero/skills/:name", () => {
    it("should update skill content", async () => {
      await postSkillReq(
        { name: "my-skill", files: singleFile("# Original") },
        testCliToken,
      );

      const response = await putSkillReq(
        "my-skill",
        { files: singleFile("# Updated Content") },
        testCliToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.content).toBe("# Updated Content");
      expect(data.files).toEqual([{ path: "SKILL.md", size: 17 }]);
    });

    it("should return 404 for non-existent skill", async () => {
      const response = await putSkillReq(
        "no-such-skill",
        { files: singleFile("# Content") },
        testCliToken,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/zero/skills/:name", () => {
    it("should delete skill and return 204", async () => {
      await postSkillReq(
        { name: "my-skill", files: singleFile("# Content") },
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
        { name: "shared-skill", files: singleFile("# Shared") },
        testCliToken,
      );

      // Bind to two agents
      const agent1 = await createTestCompose(`agent1-${user.userId.slice(-8)}`);
      const agent2 = await createTestCompose(`agent2-${user.userId.slice(-8)}`);
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

  describe("admin permission restriction", () => {
    let memberToken: string;

    beforeEach(async () => {
      const orgId = `org_mock_${user.userId}`;

      // Ensure the admin user's role is cached so Clerk mock override doesn't matter
      await insertOrgMembersCacheEntry({
        orgId,
        userId: user.userId,
        role: "admin",
      });

      // Create a member token directly (avoid setupUser which overrides Clerk mock)
      const memberUserId = `member-${Date.now()}`;
      memberToken = await createTestCliToken(memberUserId, undefined, orgId);

      await insertOrgMembersCacheEntry({
        orgId,
        userId: memberUserId,
        role: "member",
      });
    });

    it("should return 403 when member creates a skill", async () => {
      const response = await postSkillReq(
        { name: "member-skill", files: singleFile("# Content") },
        memberToken,
      );

      expect(response.status).toBe(403);
    });

    it("should return 403 when member updates a skill", async () => {
      // Create skill as admin
      await postSkillReq(
        { name: "admin-skill", files: singleFile("# Original") },
        testCliToken,
      );

      // Try to update as member
      const response = await putSkillReq(
        "admin-skill",
        { files: singleFile("# Updated") },
        memberToken,
      );

      expect(response.status).toBe(403);
    });

    it("should return 403 when member deletes a skill", async () => {
      // Create skill as admin
      await postSkillReq(
        { name: "admin-skill", files: singleFile("# Content") },
        testCliToken,
      );

      // Try to delete as member
      const response = await deleteSkillReq("admin-skill", memberToken);

      expect(response.status).toBe(403);
    });

    it("should allow member to list skills", async () => {
      // Create skill as admin
      await postSkillReq(
        { name: "readable-skill", files: singleFile("# Content") },
        testCliToken,
      );

      // Member should be able to list
      const response = await listSkillsReq(memberToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("readable-skill");
    });

    it("should allow member to get a skill", async () => {
      // Create skill as admin
      await postSkillReq(
        { name: "readable-skill", files: singleFile("# Readable") },
        testCliToken,
      );

      mockSkillContent("# Readable");

      // Member should be able to read
      const response = await getSkillReq("readable-skill", memberToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("readable-skill");
    });

    it("should allow admin to create a skill", async () => {
      const response = await postSkillReq(
        { name: "admin-created", files: singleFile("# Admin") },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.name).toBe("admin-created");
    });
  });
});
