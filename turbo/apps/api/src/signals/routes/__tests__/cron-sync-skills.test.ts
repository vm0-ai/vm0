import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
} from "@vm0/core/github-url";
import { getSkillStorageName, SYSTEM_ORG_ID } from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import {
  cleanupOfficialTestSkillsState,
  findSkillByUrlState,
  findSystemStorageByNameState,
  seedCurrentSkillVersionsState,
  setAllSkillsCommitShaState,
} from "./helpers/cron-sync-skills-state";

const context = testContext();
const BUCKET = "test-user-storages";
const TEST_SKILL_PREFIX = "api-test-skill";
// The service validates SEED_SKILLS; alpha and beta cover arbitrary repository
// entries without coupling these route tests to the connector registry size.
const REQUIRED_SEED_SKILL_NAMES = SEED_SKILLS;
const STALE_PRESEEDED_COMMIT_SHA = "0".repeat(40);

interface MockSkillEntry {
  readonly name: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

interface MockSkillVersion {
  readonly name: string;
  readonly url: string;
  readonly fullPath: string;
  readonly storageName: string;
  readonly versionHash: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
  };
}

const EXTRA_SKILLS = {
  alphaSkill: {
    name: `${TEST_SKILL_PREFIX}-alpha`,
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          `name: ${TEST_SKILL_PREFIX}-alpha`,
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
    name: `${TEST_SKILL_PREFIX}-beta`,
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          `name: ${TEST_SKILL_PREFIX}-beta`,
          "description: Beta integration",
          "---",
          "",
          "# Beta Skill",
        ].join("\n"),
      },
    ],
  },
} satisfies Record<string, MockSkillEntry>;

function officialTestSkillUrlPrefix(): string {
  return `https://github.com/vm0-ai/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${TEST_SKILL_PREFIX}-`;
}

async function cleanupOfficialTestSkills(): Promise<void> {
  await cleanupOfficialTestSkillsState(context, officialTestSkillUrlPrefix());
}

async function setAllSkillsCommitSha(commitSha: string): Promise<void> {
  const skillName = `${TEST_SKILL_PREFIX}-existing`;
  await setAllSkillsCommitShaState(context, {
    skillName,
    url: testSkillUrl(skillName),
    fullPath: `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`,
    commitSha,
    frontmatter: {
      name: skillName,
      description: `${skillName} skill`,
    },
  });
}

async function seedCurrentSkillVersions(
  entries: readonly MockSkillEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  await seedCurrentSkillVersionsState(context, {
    staleCommitSha: STALE_PRESEEDED_COMMIT_SHA,
    versions: entries.map((entry) => {
      const version = buildMockSkillVersion(entry);
      return {
        name: version.name,
        url: version.url,
        full_path: version.fullPath,
        storage_name: version.storageName,
        version_hash: version.versionHash,
        s3_prefix: version.s3Prefix,
        s3_key: version.s3Key,
        size: version.size,
        archive_size: version.archiveSize,
        file_count: version.fileCount,
        frontmatter: version.frontmatter,
      };
    }),
  });
}

function newCommitSha(): string {
  return randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40);
}

function createGitRefsResponse(commitSha: string): string {
  const header = "001e# service=git-upload-pack\n0000";
  const refLine = `003f${commitSha} refs/heads/main\n`;
  return header + refLine;
}

function seedSkillEntries(): MockSkillEntry[] {
  return REQUIRED_SEED_SKILL_NAMES.map((name) => {
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

function createFullSkillTree(
  extras: readonly MockSkillEntry[],
): readonly MockSkillEntry[] {
  return [...seedSkillEntries(), ...extras];
}

function buildMockSkillVersion(skill: MockSkillEntry): MockSkillVersion {
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skill.name}`;
  const storageName = getSkillStorageName(fullPath);
  const versionHash = computeMockSkillVersionHash(skill);
  const s3Prefix = `${SYSTEM_ORG_ID}/volume/${storageName}`;
  const s3Key = `${s3Prefix}/${versionHash}`;
  return {
    name: skill.name,
    url: testSkillUrl(skill.name),
    fullPath,
    storageName,
    versionHash,
    s3Prefix,
    s3Key,
    size: skill.files.reduce((sum, file) => {
      return sum + Buffer.byteLength(file.content);
    }, 0),
    archiveSize: 1,
    fileCount: skill.files.length,
    frontmatter: {
      name: skill.name,
      description: `${skill.name} skill`,
    },
  };
}

function computeMockSkillVersionHash(skill: MockSkillEntry): string {
  const fileEntries = skill.files
    .map((file) => {
      const hash = createHash("sha256").update(file.content).digest("hex");
      return `${file.path}:${hash}`;
    })
    .sort();
  return createHash("sha256")
    .update(
      `system-skill:${testSkillUrl(skill.name)}\n${fileEntries.join("\n")}`,
    )
    .digest("hex");
}

async function seedCurrentSeedSkillVersions(): Promise<void> {
  await seedCurrentSkillVersions(seedSkillEntries());
}

function setupGitRefsHandler(commitSha: string): void {
  server.use(
    http.get("https://github.com/vm0-ai/vm0-skills.git/info/refs", () => {
      return new HttpResponse(createGitRefsResponse(commitSha));
    }),
  );
}

function mockGitBlobSha(content: string): string {
  const bytes = Buffer.byteLength(content);
  return createHash("sha1")
    .update(`blob ${bytes}\0`)
    .update(content)
    .digest("hex");
}

function setupMswHandlersWithTrees(
  commitSha: string,
  mockSkills: readonly MockSkillEntry[],
  mockGitTreesByCommit: Map<string, readonly MockSkillEntry[]>,
): void {
  setupGitRefsHandler(commitSha);
  mockGitTreesByCommit.set(commitSha, mockSkills);
  const handlers = [
    http.get(
      "https://api.github.com/repos/vm0-ai/vm0-skills/git/trees/:commitSha",
      ({ params }) => {
        const treeCommitSha = String(params.commitSha);
        const treeSkills = mockGitTreesByCommit.get(treeCommitSha) ?? [];
        return HttpResponse.json({
          sha: treeCommitSha,
          truncated: false,
          tree: treeSkills.flatMap((skill) => {
            return skill.files.map((file) => {
              const path = `${skill.name}/${file.path}`;
              return {
                path,
                mode: "100644",
                type: "blob",
                sha: mockGitBlobSha(file.content),
                size: Buffer.byteLength(file.content),
                url: `https://api.github.com/repos/vm0-ai/vm0-skills/git/blobs/${mockGitBlobSha(file.content)}`,
              };
            });
          }),
        });
      },
    ),
    ...mockSkills.flatMap((skill) => {
      return skill.files.map((file) => {
        const path = `${skill.name}/${file.path}`
          .split("/")
          .map((segment) => {
            return encodeURIComponent(segment);
          })
          .join("/");
        return http.get(
          `https://raw.githubusercontent.com/vm0-ai/vm0-skills/${commitSha}/${path}`,
          () => {
            return new HttpResponse(file.content);
          },
        );
      });
    }),
  ];
  server.use(...handlers);
}

function commandName(command: unknown): string {
  return command instanceof Object && "constructor" in command
    ? command.constructor.name
    : "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null
  ) {
    return {};
  }
  return command.input as Record<string, unknown>;
}

function s3CallsByName(name: string): unknown[] {
  return context.mocks.s3.send.mock.calls
    .map((call) => {
      return call[0];
    })
    .filter((command) => {
      return commandName(command) === name;
    });
}

function successfulS3Response(command: unknown): Promise<unknown> {
  if (commandName(command) === "CreateMultipartUploadCommand") {
    return Promise.resolve({ UploadId: randomUUID() });
  }
  if (commandName(command) === "UploadPartCommand") {
    const partNumber = commandInput(command).PartNumber;
    return Promise.resolve({ ETag: `etag-${String(partNumber)}` });
  }
  return Promise.resolve({});
}

function uploadedBytesForKeySuffix(keySuffix: string): number {
  return s3CallsByName("UploadPartCommand")
    .filter((command) => {
      const key = commandInput(command).Key;
      return typeof key === "string" && key.endsWith(keySuffix);
    })
    .reduce<number>((total, command) => {
      const body = commandInput(command).Body;
      if (!Buffer.isBuffer(body)) {
        throw new Error("Expected a multipart upload body");
      }
      return total + body.length;
    }, 0);
}

function setupS3ListObjects(keys: readonly string[]): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (commandName(command) === "ListObjectsV2Command") {
      return Promise.resolve({
        Contents: keys.map((key) => {
          return {
            Key: key,
            Size: 1,
            LastModified: new Date("2026-05-14T00:00:00.000Z"),
          };
        }),
      });
    }
    return successfulS3Response(command);
  });
}

function testSkillUrl(name: string): string {
  return `https://github.com/vm0-ai/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${name}`;
}

async function findSkillByUrl(url: string): Promise<{
  readonly fullPath: string;
  readonly commitSha: string | null;
  readonly versionHash: string | null;
  readonly fileCount: number;
  readonly frontmatter: unknown;
} | null> {
  return await findSkillByUrlState(context, url);
}

async function findSystemStorageByName(name: string): Promise<{
  readonly headVersionId: string | null;
  readonly size: number;
  readonly versionSize: number | null;
  readonly archiveSize: number | null;
} | null> {
  return await findSystemStorageByNameState(context, name);
}

describe("GET /api/cron/sync-skills", () => {
  const mockGitTreesByCommit = new Map<string, readonly MockSkillEntry[]>();
  const setupMswHandlers = (
    commitSha: string,
    mockSkills: readonly MockSkillEntry[],
  ): void => {
    setupMswHandlersWithTrees(commitSha, mockSkills, mockGitTreesByCommit);
  };

  beforeEach(() => {
    mockGitTreesByCommit.clear();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockImplementation(successfulS3Response);
  });

  afterEach(async () => {
    await cleanupOfficialTestSkills();
  });

  it("skips sync when the stored commit SHA is unchanged", async () => {
    const commitSha = newCommitSha();
    await setAllSkillsCommitSha(commitSha);
    setupGitRefsHandler(commitSha);

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      commitSha,
      synced: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: 0,
    });
  });

  it("syncs new skills from the repository tree", async () => {
    const commitSha = newCommitSha();
    await seedCurrentSeedSkillVersions();
    setupMswHandlers(
      commitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.success).toBeTruthy();
    expect(response.body.commitSha).toBe(commitSha);
    expect(response.body.synced + response.body.skipped).toBeGreaterThan(0);

    const alphaSkill = await findSkillByUrl(
      testSkillUrl(EXTRA_SKILLS.alphaSkill.name),
    );
    expect(alphaSkill).toMatchObject({
      fullPath: `vm0-ai/vm0-skills/tree/main/${EXTRA_SKILLS.alphaSkill.name}`,
      commitSha,
      fileCount: 2,
      frontmatter: {
        name: EXTRA_SKILLS.alphaSkill.name,
        description: "Alpha integration skill",
      },
    });
    expect(alphaSkill?.versionHash).toBeTruthy();

    const alphaStorage = await findSystemStorageByName(
      getSkillStorageName(
        `vm0-ai/vm0-skills/tree/main/${EXTRA_SKILLS.alphaSkill.name}`,
      ),
    );
    const alphaVersion = buildMockSkillVersion(EXTRA_SKILLS.alphaSkill);
    const alphaArchiveCopy = s3CallsByName("CopyObjectCommand").find(
      (command) => {
        const key = commandInput(command).Key;
        return (
          typeof key === "string" &&
          key.endsWith(`/${alphaVersion.versionHash}/archive.tar.gz`)
        );
      },
    );
    expect(alphaArchiveCopy).toBeDefined();
    const alphaArchiveSize = uploadedBytesForKeySuffix(
      `-${EXTRA_SKILLS.alphaSkill.name}.tar.gz`,
    );
    expect(alphaStorage).toMatchObject({
      headVersionId: expect.any(String),
      size: alphaVersion.size,
      versionSize: alphaVersion.size,
      archiveSize: alphaArchiveSize,
    });
    expect(alphaArchiveSize).toBeGreaterThan(0);
    expect(s3CallsByName("CopyObjectCommand")).toHaveLength(2);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);
  });

  it("mounts only the current default seed skills in claimed runs", async () => {
    const commitSha = newCommitSha();
    setupMswHandlers(commitSha, createFullSkillTree([]));
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Seed Skill Mount Agent",
      visibility: "private",
    });

    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "inspect default seed skill mounts",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    const skillMountPaths =
      expectCanonicalStorageManifest(claim.storageManifest)
        ?.storageMounts.map((storage) => {
          return storage.mountPath;
        })
        .filter((mountPath) => {
          return mountPath.startsWith("/home/user/.claude/skills/");
        })
        .sort() ?? [];

    expect(skillMountPaths).toStrictEqual([
      "/home/user/.claude/skills/computer-use",
      "/home/user/.claude/skills/gen",
      "/home/user/.claude/skills/workflow-setup",
    ]);
    expect(skillMountPaths).not.toContain(
      "/home/user/.claude/skills/deep-dive",
    );

    await runs.requestCancelRun(actor, run.runId, [200]);
  });

  it("excludes repository directories without a SKILL.md file", async () => {
    const commitSha = newCommitSha();
    const nonSkillDirectory = {
      name: `${TEST_SKILL_PREFIX}-no-skill-md`,
      files: [{ path: "README.md", content: "Not a skill." }],
    };
    await seedCurrentSeedSkillVersions();
    setupMswHandlers(
      commitSha,
      createFullSkillTree([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
        nonSkillDirectory,
      ]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.total).toBe(REQUIRED_SEED_SKILL_NAMES.length + 2);
    await expect(
      findSkillByUrl(testSkillUrl(nonSkillDirectory.name)),
    ).resolves.toBeNull();
  });

  it("skips malformed skill frontmatter and syncs other skills", async () => {
    const commitSha = newCommitSha();
    const badSkill = {
      name: `${TEST_SKILL_PREFIX}-bad-yaml`,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${TEST_SKILL_PREFIX}-bad-yaml`,
            "description:",
            "  - not_a_string",
            "- BAD_LINE",
            "---",
            "",
            "# Bad YAML Skill",
          ].join("\n"),
        },
      ],
    };
    await seedCurrentSeedSkillVersions();
    setupMswHandlers(
      commitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill, badSkill]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.failed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.alphaSkill.name)),
    ).resolves.not.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(badSkill.name)),
    ).resolves.toBeNull();
  });

  it("retries a transient skill download failure at the same commit", async () => {
    const commitSha = newCommitSha();
    const sourceSkills = createFullSkillTree([EXTRA_SKILLS.alphaSkill]);
    const alphaSkillMd = EXTRA_SKILLS.alphaSkill.files.find((file) => {
      return file.path === "SKILL.md";
    });
    if (!alphaSkillMd) {
      throw new Error("Expected the alpha SKILL.md fixture");
    }
    setupMswHandlers(commitSha, sourceSkills);
    let alphaSkillMdRequests = 0;
    server.use(
      http.get(
        `https://raw.githubusercontent.com/vm0-ai/vm0-skills/${commitSha}/${EXTRA_SKILLS.alphaSkill.name}/SKILL.md`,
        () => {
          alphaSkillMdRequests++;
          if (alphaSkillMdRequests === 1) {
            return new HttpResponse(null, { status: 503 });
          }
          return new HttpResponse(alphaSkillMd.content);
        },
      ),
    );

    const failedResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(failedResponse.body.failed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.alphaSkill.name)),
    ).resolves.toBeNull();
    expect(s3CallsByName("AbortMultipartUploadCommand")).toHaveLength(1);

    const retriedResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(retriedResponse.body.failed).toBe(0);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.alphaSkill.name)),
    ).resolves.toMatchObject({ commitSha });
  });

  it("only uploads changed skills during incremental sync", async () => {
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions();
    setupMswHandlers(
      firstCommitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    context.mocks.s3.send.mockClear();
    const nextCommitSha = newCommitSha();
    const modifiedAlpha = {
      name: EXTRA_SKILLS.alphaSkill.name,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${EXTRA_SKILLS.alphaSkill.name}`,
            "description: Updated alpha skill",
            "---",
            "",
            "# Alpha Skill v2",
          ].join("\n"),
        },
        { path: "index.ts", content: 'console.log("alpha v2");' },
      ],
    };
    setupMswHandlers(
      nextCommitSha,
      createFullSkillTree([modifiedAlpha, EXTRA_SKILLS.betaSkill]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.commitSha).toBe(nextCommitSha);
    expect(response.body.synced).toBe(1);
    expect(response.body.skipped).toBeGreaterThanOrEqual(1);
    expect(s3CallsByName("CopyObjectCommand")).toHaveLength(1);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(1);

    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.alphaSkill.name)),
    ).resolves.toMatchObject({
      commitSha: nextCommitSha,
      frontmatter: {
        name: EXTRA_SKILLS.alphaSkill.name,
        description: "Updated alpha skill",
      },
    });
  });

  it("removes skills deleted from the source repository and cleans S3 objects", async () => {
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions();
    setupMswHandlers(
      firstCommitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    context.mocks.s3.send.mockClear();
    setupS3ListObjects(["mock/archive.tar.gz", "mock/manifest.json"]);
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.removed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.betaSkill.name)),
    ).resolves.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.alphaSkill.name)),
    ).resolves.not.toBeNull();

    const deleteCommand = s3CallsByName("DeleteObjectsCommand")[0];
    expect(commandInput(deleteCommand)).toMatchObject({
      Bucket: BUCKET,
      Delete: {
        Objects: [
          { Key: "mock/archive.tar.gz" },
          { Key: "mock/manifest.json" },
        ],
      },
    });
  });

  it("keeps DB orphan removal when S3 cleanup fails", async () => {
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions();
    setupMswHandlers(
      firstCommitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.reject(new Error("S3 connection failed"));
      }
      return successfulS3Response(command);
    });
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullSkillTree([EXTRA_SKILLS.alphaSkill]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.removed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.betaSkill.name)),
    ).resolves.toBeNull();
  });

  it("logs when seed skills are missing from the source repository", async () => {
    mockEnv("AXIOM_TOKEN_TELEMETRY", "test-token");
    mockEnv("AXIOM_DATASET_SUFFIX", "dev");
    const omittedSkills = SEED_SKILLS.slice(0, 2);
    const omittedSkillSet = new Set(omittedSkills);
    const keptSkills = REQUIRED_SEED_SKILL_NAMES.filter((name) => {
      return !omittedSkillSet.has(name);
    });
    const commitSha = newCommitSha();
    setupMswHandlers(
      commitSha,
      keptSkills.map((name) => {
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

    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
      expect.stringContaining("SEED_SKILLS references skills not found"),
      expect.objectContaining({
        context: "skills:sync",
        missingSkills: expect.arrayContaining([
          expect.stringContaining("vm0-ai/vm0-skills"),
        ]),
      }),
    );

    const restoreCommitSha = newCommitSha();
    setupMswHandlers(restoreCommitSha, createFullSkillTree([]));
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);
  });
});
