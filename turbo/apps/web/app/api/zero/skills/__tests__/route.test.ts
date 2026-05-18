import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
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
  createTestVolumeForOrg,
  createTestZeroSkill,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

let user: UserContext;
let testCliToken: string;

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

async function createStoredSkill(name: string): Promise<void> {
  await createTestZeroSkill(user.orgId, name);
  await createTestVolumeForOrg(user.orgId, getCustomSkillStorageName(name));
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

  describe("GET /api/zero/skills/:name", () => {
    it("should return 401 when authenticated session has no active organization", async () => {
      mockClerk({ userId: user.userId, orgId: null });

      const response = await getSkill(
        createTestRequest(`http://localhost:3000/api/zero/skills/any-skill`, {
          method: "GET",
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("should return skill with content", async () => {
      await createStoredSkill("my-skill");

      mockSkillContent("# My Skill Content");

      const response = await getSkillReq("my-skill", testCliToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("my-skill");
      expect(data.displayName).toBeNull();
      expect(data.content).toBe("# My Skill Content");
      expect(data.files).toEqual([{ path: "SKILL.md", size: 18 }]);
    });

    it("should return file listing for multi-file skill", async () => {
      await createStoredSkill("multi-skill");

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
      await createStoredSkill("my-skill");

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
      await createStoredSkill("my-skill");

      const response = await deleteSkillReq("my-skill", testCliToken);

      expect(response.status).toBe(204);

      const getResponse = await getSkillReq("my-skill", testCliToken);
      expect(getResponse.status).toBe(404);
    });

    it("should unbind skill from all agents on delete", async () => {
      await createStoredSkill("shared-skill");

      // Bind to two agents
      const agent1 = await createTestCompose(`agent1-${user.userId.slice(-8)}`);
      const agent2 = await createTestCompose(`agent2-${user.userId.slice(-8)}`);
      await bindCustomSkillToAgent(agent1.agentId, "shared-skill");
      await bindCustomSkillToAgent(agent2.agentId, "shared-skill");

      // Delete the skill at org level
      const response = await deleteSkillReq("shared-skill", testCliToken);

      expect(response.status).toBe(204);

      await expect(getAgentCustomSkills(agent1.agentId)).resolves.toEqual([]);
      await expect(getAgentCustomSkills(agent2.agentId)).resolves.toEqual([]);
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

    it("should return 403 when member updates a skill", async () => {
      await createStoredSkill("admin-skill");

      // Try to update as member
      const response = await putSkillReq(
        "admin-skill",
        { files: singleFile("# Updated") },
        memberToken,
      );

      expect(response.status).toBe(403);
    });

    it("should return 403 when member deletes a skill", async () => {
      await createStoredSkill("admin-skill");

      // Try to delete as member
      const response = await deleteSkillReq("admin-skill", memberToken);

      expect(response.status).toBe(403);
    });

    it("should allow member to get a skill", async () => {
      await createStoredSkill("readable-skill");

      mockSkillContent("# Readable");

      // Member should be able to read
      const response = await getSkillReq("readable-skill", memberToken);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("readable-skill");
    });
  });
});
