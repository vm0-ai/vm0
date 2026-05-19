import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getEligibleConnectorTypes } from "@vm0/connectors/connector-utils";
import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
} from "@vm0/core/github-url";
import { getSkillStorageName } from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { cronSyncSkillsContract } from "@vm0/api-contracts/contracts/cron";
import { skills } from "@vm0/db/schema/skill";
import { storages } from "@vm0/db/schema/storage";
import { createStore, command } from "ccstate";
import { eq, inArray, like } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storages";
const TEST_SKILL_PREFIX = "api-test-skill";
const ALL_SEED_SKILL_NAMES: readonly string[] = [
  ...new Set([...SEED_SKILLS, ...getEligibleConnectorTypes()]),
];

interface MockSkillEntry {
  readonly name: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
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

const cleanupOfficialTestSkills$ = command(
  async ({ set }, _input: void, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const urlPrefix = `https://github.com/vm0-ai/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${TEST_SKILL_PREFIX}-`;
    const skillRows = await db
      .select({ id: skills.id, storageId: skills.storageId })
      .from(skills)
      .where(like(skills.url, `${urlPrefix}%`));
    signal.throwIfAborted();

    if (skillRows.length === 0) {
      return;
    }

    const skillIds = skillRows.map((row) => {
      return row.id;
    });
    const storageIds = skillRows
      .map((row) => {
        return row.storageId;
      })
      .filter((id): id is string => {
        return id !== null;
      });

    await db.delete(skills).where(inArray(skills.id, skillIds));
    signal.throwIfAborted();
    if (storageIds.length > 0) {
      await db.delete(storages).where(inArray(storages.id, storageIds));
      signal.throwIfAborted();
    }
  },
);

const setAllSkillsCommitSha$ = command(
  async ({ set }, commitSha: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const skillName = `${TEST_SKILL_PREFIX}-existing`;
    await db
      .insert(skills)
      .values({
        url: testSkillUrl(skillName),
        name: skillName,
        fullPath: `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`,
        commitSha,
        frontmatter: {
          name: skillName,
          description: `${skillName} skill`,
        },
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    await db.update(skills).set({ commitSha });
    signal.throwIfAborted();
  },
);

function apiClient() {
  return setupApp({ context })(cronSyncSkillsContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function newCommitSha(): string {
  return randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40);
}

function createGitRefsResponse(commitSha: string): string {
  const header = "001e# service=git-upload-pack\n0000";
  const refLine = `003f${commitSha} refs/heads/main\n`;
  return header + refLine;
}

function createMockTarball(mockSkills: readonly MockSkillEntry[]): Buffer {
  const tmpDir = mkdtempSync(join(tmpdir(), "vm0-api-test-tarball-"));
  const prefix = `${DEFAULT_SKILLS_REPO}-${DEFAULT_SKILLS_BRANCH}`;

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

  const tarPath = join(tmpDir, "test.tar.gz");
  createTar({ gzip: true, file: tarPath, cwd: tmpDir, sync: true }, filePaths);
  const tarball = readFileSync(tarPath);
  rmSync(tmpDir, { recursive: true, force: true });
  return tarball;
}

function seedSkillEntries(): MockSkillEntry[] {
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

function createFullTarball(extras: readonly MockSkillEntry[]): Buffer {
  return createMockTarball([...seedSkillEntries(), ...extras]);
}

function setupGitRefsHandler(commitSha: string): void {
  server.use(
    http.get("https://github.com/vm0-ai/vm0-skills.git/info/refs", () => {
      return new HttpResponse(createGitRefsResponse(commitSha));
    }),
  );
}

function setupMswHandlers(commitSha: string, tarball: Buffer): void {
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
    return Promise.resolve({});
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
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      fullPath: skills.fullPath,
      commitSha: skills.commitSha,
      versionHash: skills.versionHash,
      fileCount: skills.fileCount,
      frontmatter: skills.frontmatter,
    })
    .from(skills)
    .where(eq(skills.url, url))
    .limit(1);
  return row ?? null;
}

async function findSystemStorageByName(name: string): Promise<{
  readonly type: string;
  readonly headVersionId: string | null;
} | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      type: storages.type,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(eq(storages.name, name))
    .limit(1);
  return row ?? null;
}

describe("GET /api/cron/sync-skills", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(async () => {
    await store.set(cleanupOfficialTestSkills$, undefined, context.signal);
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().sync({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with no authorization header", async () => {
    const response = await accept(apiClient().sync({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("skips sync when the stored commit SHA is unchanged", async () => {
    const commitSha = newCommitSha();
    await store.set(setAllSkillsCommitSha$, commitSha, context.signal);
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

  it("syncs new skills from the repository tarball", async () => {
    const commitSha = newCommitSha();
    setupMswHandlers(
      commitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
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
    expect(alphaStorage).toMatchObject({
      type: "volume",
      headVersionId: expect.any(String),
    });
  });

  it("excludes repository directories without a SKILL.md file", async () => {
    const commitSha = newCommitSha();
    const nonSkillDirectory = {
      name: `${TEST_SKILL_PREFIX}-no-skill-md`,
      files: [{ path: "README.md", content: "Not a skill." }],
    };
    setupMswHandlers(
      commitSha,
      createFullTarball([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
        nonSkillDirectory,
      ]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.total).toBe(ALL_SEED_SKILL_NAMES.length + 2);
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
    setupMswHandlers(
      commitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill, badSkill]),
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

  it("only uploads changed skills during incremental sync", async () => {
    const firstCommitSha = newCommitSha();
    setupMswHandlers(
      firstCommitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
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
      createFullTarball([modifiedAlpha, EXTRA_SKILLS.betaSkill]),
    );

    const response = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.commitSha).toBe(nextCommitSha);
    expect(response.body.synced).toBe(1);
    expect(response.body.skipped).toBeGreaterThanOrEqual(1);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);

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
    setupMswHandlers(
      firstCommitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    setupS3ListObjects(["mock/archive.tar.gz", "mock/manifest.json"]);
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill]),
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
    setupMswHandlers(
      firstCommitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.reject(new Error("S3 connection failed"));
      }
      return Promise.resolve({});
    });
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill]),
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
    const keptSkills = ALL_SEED_SKILL_NAMES.filter((name) => {
      return !omittedSkillSet.has(name);
    });
    const commitSha = newCommitSha();
    setupMswHandlers(
      commitSha,
      createMockTarball(
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
      ),
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
    setupMswHandlers(restoreCommitSha, createFullTarball([]));
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);
  });
});
