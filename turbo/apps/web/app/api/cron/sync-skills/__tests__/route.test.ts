import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
import {
  createTestRequest,
  clearSkillsData,
  findTestSkillByUrl,
  findAllTestSkills,
  findTestSystemStorages,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { server } from "../../../../../src/mocks/server";
import { logger } from "../../../../../src/lib/logger";

const context = testContext();
const cronSecret = "test-cron-secret";
const TEST_COMMIT_SHA = "a".repeat(40);

function cronRequest(secret?: string) {
  return createTestRequest(
    "http://localhost:3000/api/cron/sync-skills",
    secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined,
  );
}

/**
 * Create a mock pkt-line response for git smart HTTP info/refs.
 * Simplified format — real responses have more lines, but the parser
 * only looks for the refs/heads/main line.
 */
function createGitRefsResponse(commitSha: string): string {
  const header = "001e# service=git-upload-pack\n0000";
  const refLine = `003f${commitSha} refs/heads/main\n`;
  return header + refLine;
}

/**
 * Create a gzipped tarball buffer containing mock skills.
 * Mimics the GitHub codeload format with a {repo}-{branch}/ prefix.
 */
function createMockTarball(
  mockSkills: Array<{
    name: string;
    files: Array<{ path: string; content: string }>;
  }>,
): Buffer {
  const tmpDir = mkdtempSync(join(tmpdir(), "vm0-test-tarball-"));
  const prefix = "vm0-skills-main";

  try {
    // Create directory structure
    mkdirSync(join(tmpDir, prefix), { recursive: true });

    const filePaths: string[] = [];
    for (const skill of mockSkills) {
      const skillDir = join(tmpDir, prefix, skill.name);
      mkdirSync(skillDir, { recursive: true });

      for (const file of skill.files) {
        const filePath = join(skillDir, file.path);
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, file.content);
        filePaths.push(join(prefix, skill.name, file.path));
      }
    }

    // Create tar.gz
    const tarPath = join(tmpDir, "test.tar.gz");
    tar.create(
      { gzip: true, file: tarPath, cwd: tmpDir, sync: true },
      filePaths,
    );
    return readFileSync(tarPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Standard mock skills for testing */
const MOCK_SKILLS = [
  {
    name: "slack",
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          "name: slack",
          "description: Slack integration skill",
          "---",
          "",
          "# Slack Skill",
          "Send messages to Slack.",
        ].join("\n"),
      },
      { path: "index.ts", content: 'console.log("slack");' },
    ],
  },
  {
    name: "github",
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          "name: github",
          "description: GitHub integration",
          "---",
          "",
          "# GitHub Skill",
        ].join("\n"),
      },
    ],
  },
];

function setupMswHandlers(commitSha: string, tarball: Buffer) {
  server.use(
    http.get(
      "https://github.com/vm0-ai/vm0-skills.git/info/refs",
      () => new HttpResponse(createGitRefsResponse(commitSha)),
    ),
    http.get(
      "https://codeload.github.com/vm0-ai/vm0-skills/tar.gz/refs/heads/main",
      () => new HttpResponse(tarball),
    ),
  );
}

describe("GET /api/cron/sync-skills", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", cronSecret);
    reloadEnv();
    await clearSkillsData();
  });

  describe("Authentication", () => {
    it("should reject request without cron secret", async () => {
      const response = await GET(cronRequest());
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject request with invalid cron secret", async () => {
      const response = await GET(cronRequest("wrong-secret"));
      expect(response.status).toBe(401);
    });

    it("should accept request with valid cron secret", async () => {
      const tarball = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  describe("Freshness check", () => {
    it("should skip sync when commit SHA is unchanged", async () => {
      const tarball = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball);

      // First sync — populates DB
      const response1 = await GET(cronRequest(cronSecret));
      expect(response1.status).toBe(200);
      const data1 = await response1.json();
      expect(data1.synced).toBe(2);

      // Second sync with same commit SHA — should skip
      const response2 = await GET(cronRequest(cronSecret));
      expect(response2.status).toBe(200);
      const data2 = await response2.json();
      expect(data2.synced).toBe(0);
      expect(data2.skipped).toBe(0);
      expect(data2.total).toBe(0);
    });
  });

  describe("Full sync", () => {
    it("should sync skills on first run with empty table", async () => {
      const tarball = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.commitSha).toBe(TEST_COMMIT_SHA);
      expect(data.synced).toBe(2);
      expect(data.total).toBe(2);

      // Verify skills table records
      const allSkills = await findAllTestSkills();
      expect(allSkills).toHaveLength(2);

      const slackSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
      );
      expect(slackSkill).not.toBeNull();
      expect(slackSkill!.fullPath).toBe("vm0-ai/vm0-skills/tree/main/slack");
      expect(slackSkill!.commitSha).toBe(TEST_COMMIT_SHA);
      expect(slackSkill!.versionHash).toBeTruthy();
      expect(slackSkill!.fileCount).toBe(2);
      expect(slackSkill!.frontmatter).toEqual({
        name: "slack",
        description: "Slack integration skill",
      });

      const githubSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/github",
      );
      expect(githubSkill).not.toBeNull();
      expect(githubSkill!.fileCount).toBe(1);

      // Verify storages records
      const allStorages = await findTestSystemStorages();
      expect(allStorages).toHaveLength(2);

      for (const storage of allStorages) {
        expect(storage.type).toBe("volume");
        expect(storage.headVersionId).toBeTruthy();
      }

      // Verify S3 uploads were called (manifest + archive per skill = 4 calls)
      expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(4);
    });

    it("should skip directories without SKILL.md", async () => {
      const skillsWithExtra = [
        ...MOCK_SKILLS,
        {
          name: "no-skill-md",
          files: [{ path: "README.md", content: "Not a skill" }],
        },
      ];
      const tarball = createMockTarball(skillsWithExtra);
      setupMswHandlers(TEST_COMMIT_SHA, tarball);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      // Only 2 skills synced (slack + github), not the dir without SKILL.md
      expect(data.synced).toBe(2);
      expect(data.total).toBe(2);
    });
  });

  describe("Malformed frontmatter resilience", () => {
    it("should skip skill with malformed frontmatter and sync others", async () => {
      const skillsWithBadFrontmatter = [
        MOCK_SKILLS[0]!, // slack — valid
        {
          name: "bad-yaml",
          files: [
            {
              path: "SKILL.md",
              content: [
                "---",
                "name: bad-yaml",
                "description:",
                "  - not_a_string",
                "- BAD_LINE",
                "---",
                "",
                "# Bad YAML Skill",
              ].join("\n"),
            },
            { path: "index.ts", content: 'console.log("bad");' },
          ],
        },
        MOCK_SKILLS[1]!, // github — valid
      ];
      const tarball = createMockTarball(skillsWithBadFrontmatter);
      setupMswHandlers(TEST_COMMIT_SHA, tarball);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.synced).toBe(2); // slack + github
      expect(data.failed).toBe(1); // bad-yaml
      expect(data.total).toBe(3);

      // Verify only the valid skills were synced
      const allSkills = await findAllTestSkills();
      expect(allSkills).toHaveLength(2);
    });
  });

  describe("Incremental sync", () => {
    it("should only update changed skills", async () => {
      const tarball1 = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball1);

      // First sync
      await GET(cronRequest(cronSecret));

      // Second sync with new commit but only slack changed
      const newCommitSha = "b".repeat(40);
      const modifiedSkills = [
        {
          name: "slack",
          files: [
            {
              path: "SKILL.md",
              content: [
                "---",
                "name: slack",
                "description: Updated slack skill",
                "---",
                "",
                "# Slack Skill v2",
              ].join("\n"),
            },
            { path: "index.ts", content: 'console.log("slack v2");' },
          ],
        },
        // github stays the same
        MOCK_SKILLS[1]!,
      ];
      const tarball2 = createMockTarball(modifiedSkills);
      setupMswHandlers(newCommitSha, tarball2);

      context.mocks.s3.putS3Object.mockClear();

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      expect(data.commitSha).toBe(newCommitSha);
      expect(data.synced).toBe(1); // Only slack changed
      expect(data.skipped).toBe(1); // github unchanged
      expect(data.total).toBe(2);

      // Only 2 S3 uploads (manifest + archive for slack only)
      expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(2);

      // Verify updated frontmatter
      const slackSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
      );
      expect(slackSkill!.frontmatter).toEqual({
        name: "slack",
        description: "Updated slack skill",
      });
      expect(slackSkill!.commitSha).toBe(newCommitSha);
    });
  });

  describe("Orphan removal", () => {
    it("should remove skills deleted from source repo", async () => {
      // First sync: both slack and github exist
      const tarball1 = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball1);

      await GET(cronRequest(cronSecret));

      // Verify both skills exist
      const allSkillsBefore = await findAllTestSkills();
      expect(allSkillsBefore).toHaveLength(2);
      const allStoragesBefore = await findTestSystemStorages();
      expect(allStoragesBefore).toHaveLength(2);

      // Mock listS3Objects to return objects for cleanup
      context.mocks.s3.listS3Objects.mockResolvedValue([
        { key: "mock/archive.tar.gz", size: 100 },
        { key: "mock/manifest.json", size: 50 },
      ]);

      // Second sync: only slack remains (github removed)
      const newCommitSha = "b".repeat(40);
      const tarball2 = createMockTarball([MOCK_SKILLS[0]!]);
      setupMswHandlers(newCommitSha, tarball2);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      expect(data.removed).toBe(1);
      expect(data.synced).toBe(0); // slack unchanged
      expect(data.skipped).toBe(1); // slack skipped (same hash)

      // Verify github skill is gone
      const githubSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/github",
      );
      expect(githubSkill).toBeNull();

      // Verify slack still exists
      const slackSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
      );
      expect(slackSkill).not.toBeNull();

      // Verify only 1 skill and 1 storage remain
      const allSkillsAfter = await findAllTestSkills();
      expect(allSkillsAfter).toHaveLength(1);
      const allStoragesAfter = await findTestSystemStorages();
      expect(allStoragesAfter).toHaveLength(1);

      // Verify S3 cleanup was called
      expect(context.mocks.s3.listS3Objects).toHaveBeenCalled();
      expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
        expect.any(String),
        ["mock/archive.tar.gz", "mock/manifest.json"],
      );
    });

    it("should handle S3 cleanup failure gracefully", async () => {
      // First sync: both skills
      const tarball1 = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball1);
      await GET(cronRequest(cronSecret));

      // Make S3 list throw
      context.mocks.s3.listS3Objects.mockRejectedValue(
        new Error("S3 connection failed"),
      );

      // Second sync: github removed
      const newCommitSha = "b".repeat(40);
      const tarball2 = createMockTarball([MOCK_SKILLS[0]!]);
      setupMswHandlers(newCommitSha, tarball2);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      // DB cleanup should still succeed despite S3 failure
      expect(data.removed).toBe(1);

      const allSkills = await findAllTestSkills();
      expect(allSkills).toHaveLength(1);

      const allStorages = await findTestSystemStorages();
      expect(allStorages).toHaveLength(1);
    });
  });

  describe("SEED_SKILLS validation", () => {
    it("should emit log.error when SEED_SKILLS references missing skill", async () => {
      const syncLogger = logger("skills:sync");
      const errorSpy = vi.spyOn(syncLogger, "error");

      // Sync with skills that don't include all SEED_SKILLS entries
      // (SEED_SKILLS has 30+ entries, but tarball only has slack + github)
      const tarball = createMockTarball(MOCK_SKILLS);
      setupMswHandlers(TEST_COMMIT_SHA, tarball);

      await GET(cronRequest(cronSecret));

      expect(errorSpy).toHaveBeenCalledWith(
        "SEED_SKILLS references skills not found in repository",
        expect.objectContaining({
          missingSkills: expect.arrayContaining([
            expect.stringContaining("vm0-ai/vm0-skills"),
          ]),
        }),
      );

      errorSpy.mockRestore();
    });
  });
});
