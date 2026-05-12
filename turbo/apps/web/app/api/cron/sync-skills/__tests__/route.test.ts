import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
import {
  createTestRequest,
  findTestSkillByUrl,
  findTestSystemStorageByName,
  reseedSkills,
  setAllTestSkillsCommitSha,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { server } from "../../../../../src/mocks/server";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  createMockTarball,
  ALL_SEED_SKILL_NAMES,
} from "../../../../../src/mocks/skill-sync-handlers";

const context = testContext();
const cronSecret = "test-cron-secret";

/** Generate a unique commit SHA for each call so the freshness check never skips. */
let shaCounter = 0;
function nextCommitSha(): string {
  shaCounter++;
  return shaCounter.toString(16).padStart(40, "a");
}

function cronRequest(secret?: string) {
  return createTestRequest(
    "http://localhost:3000/api/cron/sync-skills",
    secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined,
  );
}

/**
 * Create a mock pkt-line response for git smart HTTP info/refs.
 */
function createGitRefsResponse(commitSha: string): string {
  const header = "001e# service=git-upload-pack\n0000";
  const refLine = `003f${commitSha} refs/heads/main\n`;
  return header + refLine;
}

/**
 * Extra mock skills used only in these tests.
 * Names must NOT overlap with SEED_SKILLS or connector types (e.g. avoid
 * "github", "slack" which are real connector names).
 */
const EXTRA_SKILLS = {
  alphaSkill: {
    name: "test-alpha-skill",
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          "name: test-alpha-skill",
          "description: Alpha integration skill",
          "---",
          "",
          "# Alpha Skill",
          "Send messages to Alpha.",
        ].join("\n"),
      },
      { path: "index.ts", content: 'console.log("alpha");' },
    ],
  },
  betaSkill: {
    name: "test-beta-skill",
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          "name: test-beta-skill",
          "description: Beta integration",
          "---",
          "",
          "# Beta Skill",
        ].join("\n"),
      },
    ],
  },
};

/** Build minimal seed skill entries for the tarball. */
function seedSkillEntries() {
  return ALL_SEED_SKILL_NAMES.map((name) => {
    return {
      name,
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
        },
      ],
    };
  });
}

/** Create a tarball containing all seed skills plus the given extra skills. */
function createFullTarball(
  extras: Array<{
    name: string;
    files: Array<{ path: string; content: string }>;
  }>,
) {
  return createMockTarball([...seedSkillEntries(), ...extras]);
}

function setupGitRefsHandler(commitSha: string) {
  server.use(
    http.get("https://github.com/vm0-ai/vm0-skills.git/info/refs", () => {
      return new HttpResponse(createGitRefsResponse(commitSha));
    }),
  );
}

function setupMswHandlers(commitSha: string, tarball: Buffer) {
  setupGitRefsHandler(commitSha);
  server.use(
    http.get(
      "https://codeload.github.com/vm0-ai/vm0-skills/tar.gz/refs/heads/main",
      () => {
        return new HttpResponse(tarball);
      },
    ),
  );
}

let testSha: string;

describe("GET /api/cron/sync-skills", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", cronSecret);
    reloadEnv();
    testSha = nextCommitSha();
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
      await setAllTestSkillsCommitSha(testSha);
      setupGitRefsHandler(testSha);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.total).toBe(0);
    });
  });

  describe("Freshness check", () => {
    it("should skip sync when commit SHA is unchanged", async () => {
      await setAllTestSkillsCommitSha(testSha);
      setupGitRefsHandler(testSha);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.synced).toBe(0);
      expect(data.skipped).toBe(0);
      expect(data.total).toBe(0);
    });
  });

  describe("Full sync", () => {
    it("should sync new skills added to the tarball", async () => {
      const tarball = createFullTarball([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
      ]);
      setupMswHandlers(testSha, tarball);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.commitSha).toBe(testSha);
      // Extra skills are newly synced; seeds are skipped (content unchanged)
      expect(data.synced + data.skipped).toBeGreaterThan(0);

      // Verify the two extra skills are in the database with correct data
      const alphaSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/test-alpha-skill",
      );
      expect(alphaSkill).not.toBeNull();
      expect(alphaSkill!.fullPath).toBe(
        "vm0-ai/vm0-skills/tree/main/test-alpha-skill",
      );
      expect(alphaSkill!.commitSha).toBe(testSha);
      expect(alphaSkill!.versionHash).toBeTruthy();
      expect(alphaSkill!.fileCount).toBe(2);
      expect(alphaSkill!.frontmatter).toEqual({
        name: "test-alpha-skill",
        description: "Alpha integration skill",
      });

      const betaSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/test-beta-skill",
      );
      expect(betaSkill).not.toBeNull();
      expect(betaSkill!.fileCount).toBe(1);

      // Verify storages were created for the extra skills
      const alphaStorage = await findTestSystemStorageByName(
        "agent-skills@vm0-ai/vm0-skills/tree/main/test-alpha-skill",
      );
      expect(alphaStorage).not.toBeNull();
      expect(alphaStorage!.type).toBe("volume");
      expect(alphaStorage!.headVersionId).toBeTruthy();

      const betaStorage = await findTestSystemStorageByName(
        "agent-skills@vm0-ai/vm0-skills/tree/main/test-beta-skill",
      );
      expect(betaStorage).not.toBeNull();
    }, 15_000);

    it("should skip directories without SKILL.md", async () => {
      const skillsWithExtra = [
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
        {
          name: "no-skill-md",
          files: [{ path: "README.md", content: "Not a skill" }],
        },
      ];
      const tarball = createFullTarball(skillsWithExtra);
      setupMswHandlers(testSha, tarball);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      // Extra skills synced or skipped, no-skill-md excluded from total
      expect(data.success).toBe(true);
    });
  });

  describe("Malformed frontmatter resilience", () => {
    it("should skip skill with malformed frontmatter and sync others", async () => {
      const extras = [
        EXTRA_SKILLS.alphaSkill,
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
        EXTRA_SKILLS.betaSkill,
      ];
      const tarball = createFullTarball(extras);
      setupMswHandlers(testSha, tarball);

      const response = await GET(cronRequest(cronSecret));
      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.failed).toBe(1); // bad-yaml

      // Verify valid skills exist, bad-yaml does not
      const alphaSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/test-alpha-skill",
      );
      expect(alphaSkill).not.toBeNull();

      const badSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/bad-yaml",
      );
      expect(badSkill).toBeNull();
    });
  });

  describe("Incremental sync", () => {
    it("should only update changed skills", async () => {
      const tarball1 = createFullTarball([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
      ]);
      setupMswHandlers(testSha, tarball1);

      // First sync
      await GET(cronRequest(cronSecret));

      // Second sync with new commit but only slack changed
      const newCommitSha = nextCommitSha();
      const modifiedAlpha = {
        name: "test-alpha-skill",
        files: [
          {
            path: "SKILL.md",
            content: [
              "---",
              "name: test-alpha-skill",
              "description: Updated alpha skill",
              "---",
              "",
              "# Alpha Skill v2",
            ].join("\n"),
          },
          { path: "index.ts", content: 'console.log("alpha v2");' },
        ],
      };
      const tarball2 = createFullTarball([
        modifiedAlpha,
        EXTRA_SKILLS.betaSkill,
      ]);
      setupMswHandlers(newCommitSha, tarball2);

      context.mocks.s3.putS3Object.mockClear();

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      expect(data.commitSha).toBe(newCommitSha);
      expect(data.synced).toBe(1); // Only slack changed
      expect(data.skipped).toBeGreaterThanOrEqual(1); // github + seeds unchanged

      // Only 2 S3 uploads (manifest + archive for slack only)
      expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(2);

      // Verify updated frontmatter
      const alphaSkill = await findTestSkillByUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/test-alpha-skill",
      );
      expect(alphaSkill!.frontmatter).toEqual({
        name: "test-alpha-skill",
        description: "Updated alpha skill",
      });
      expect(alphaSkill!.commitSha).toBe(newCommitSha);
    });
  });

  describe("Orphan removal", () => {
    it("should remove skills deleted from source repo", async () => {
      // First sync: seeds + slack + github
      const tarball1 = createFullTarball([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
      ]);
      setupMswHandlers(testSha, tarball1);

      await GET(cronRequest(cronSecret));

      // Verify both extra skills exist
      expect(
        await findTestSkillByUrl(
          "https://github.com/vm0-ai/vm0-skills/tree/main/test-alpha-skill",
        ),
      ).not.toBeNull();
      expect(
        await findTestSkillByUrl(
          "https://github.com/vm0-ai/vm0-skills/tree/main/test-beta-skill",
        ),
      ).not.toBeNull();

      // Mock listS3Objects to return objects for cleanup
      context.mocks.s3.listS3Objects.mockResolvedValue([
        { key: "mock/archive.tar.gz", size: 100 },
        { key: "mock/manifest.json", size: 50 },
      ]);

      // Second sync: github removed from tarball (only seeds + slack remain)
      const newCommitSha = nextCommitSha();
      const tarball2 = createFullTarball([EXTRA_SKILLS.alphaSkill]);
      setupMswHandlers(newCommitSha, tarball2);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      expect(data.removed).toBe(1);
      expect(data.skipped).toBeGreaterThanOrEqual(1); // slack + seeds unchanged

      // Verify github skill is gone
      expect(
        await findTestSkillByUrl(
          "https://github.com/vm0-ai/vm0-skills/tree/main/test-beta-skill",
        ),
      ).toBeNull();

      // Verify slack still exists
      expect(
        await findTestSkillByUrl(
          "https://github.com/vm0-ai/vm0-skills/tree/main/test-alpha-skill",
        ),
      ).not.toBeNull();

      // Verify S3 cleanup was called
      expect(context.mocks.s3.listS3Objects).toHaveBeenCalled();
      expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
        expect.any(String),
        ["mock/archive.tar.gz", "mock/manifest.json"],
      );
    });

    it("should handle S3 cleanup failure gracefully", async () => {
      // First sync: seeds + slack + github
      const tarball1 = createFullTarball([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
      ]);
      setupMswHandlers(testSha, tarball1);
      await GET(cronRequest(cronSecret));

      // Make S3 list throw
      context.mocks.s3.listS3Objects.mockRejectedValue(
        new Error("S3 connection failed"),
      );

      // Second sync: github removed
      const newCommitSha = nextCommitSha();
      const tarball2 = createFullTarball([EXTRA_SKILLS.alphaSkill]);
      setupMswHandlers(newCommitSha, tarball2);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();

      // DB cleanup should still succeed despite S3 failure
      expect(data.removed).toBe(1);

      expect(
        await findTestSkillByUrl(
          "https://github.com/vm0-ai/vm0-skills/tree/main/test-beta-skill",
        ),
      ).toBeNull();
      expect(
        await findTestSkillByUrl(
          "https://github.com/vm0-ai/vm0-skills/tree/main/test-alpha-skill",
        ),
      ).not.toBeNull();
    });
  });

  describe("SEED_SKILLS validation", () => {
    it("should emit log.error when SEED_SKILLS references missing skill", async () => {
      const syncLogger = logger("skills:sync");
      const errorSpy = vi.spyOn(syncLogger, "error");

      // Build a tarball with most seed skills but deliberately omit the first
      // two SEED_SKILLS entries.  This triggers the validation warning without
      // orphan-deleting all seeds (which would break concurrent tests).
      const { SEED_SKILLS: seedSkillNames } =
        await import("../../../../../src/lib/zero/seed-skills");
      const omitted = seedSkillNames.slice(0, 2);
      const kept = ALL_SEED_SKILL_NAMES.filter((n) => {
        return !omitted.includes(n);
      });
      const tarball = createMockTarball(
        kept.map((name) => {
          return {
            name,
            files: [
              {
                path: "SKILL.md",
                content: `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
              },
            ],
          };
        }),
      );
      setupMswHandlers(testSha, tarball);

      await GET(cronRequest(cronSecret));

      expect(errorSpy).toHaveBeenCalledWith(
        "SEED_SKILLS references skills not found in repository",
        expect.objectContaining({
          missingSkills: expect.arrayContaining([
            expect.stringContaining("vm0-ai/vm0-skills"),
          ]),
        }),
      );

      // Re-seed the omitted skills so subsequent tests aren't affected
      await reseedSkills(omitted);

      errorSpy.mockRestore();
    });
  });
});
