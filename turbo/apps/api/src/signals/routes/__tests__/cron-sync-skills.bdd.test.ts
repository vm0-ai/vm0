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

import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
} from "@vm0/core/github-url";
import { getSkillStorageName } from "@vm0/core/storage-names";
import { getSeedSkillNames, SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { cronSyncSkillsContract } from "@vm0/api-contracts/contracts/cron";
import { skills } from "@vm0/db/schema/skill";
import { storages } from "@vm0/db/schema/storage";
import { createStore, command } from "ccstate";
import { eq, inArray, like } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";

// BDD migration of the legacy `cron-sync-skills.test.ts`.
// The 10 legacy `it()`s collapse into 4 BDD `it()`s:
// (1) auth + skip chain (401 wrong secret + 401 no auth
// header + 200 skips sync when commit SHA is unchanged),
// (2) initial sync chain (200 syncs new skills from
// tarball + 200 excludes repository dirs without SKILL.md
// + 200 skips malformed frontmatter + logs the failure),
// (3) incremental sync + cleanup chain (200 uploads only
// changed skills on next commit + 200 removes skills
// deleted from the repo + cleans S3 objects + 200 keeps DB
// orphan removal when S3 cleanup fails),
// (4) seed-skills audit chain (200 logs when SEED_SKILLS
// references skills not in the source repo).

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storages";
const TEST_SKILL_PREFIX = "api-test-skill";
const ALL_SEED_SKILL_NAMES = getSeedSkillNames();

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

describe("BDD GET /api/cron/sync-skills — auth + skip chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(async () => {
    clearMockedEnv();
    await store.set(cleanupOfficialTestSkills$, undefined, context.signal);
  });

  it("gwt-wt-wt: 401 wrong secret → 401 no auth header → 200 skips sync when commit SHA is unchanged", async () => {
    // Given: a request with the wrong cron secret.

    // When + Then: 401 — Invalid cron secret.
    const wrongSecretResponse = await accept(
      apiClient().sync({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(wrongSecretResponse.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: a request with no authorization header.

    // When + Then: 401 — Invalid cron secret.
    const noAuthResponse = await accept(
      apiClient().sync({ headers: {} }),
      [401],
    );
    expect(noAuthResponse.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: the stored commit SHA matches the
    // remote refs/heads/main commit.

    // When + Then: 200 — the sync is skipped with
    // synced=0/skipped=0/failed=0/removed=0/total=0.
    const commitSha = newCommitSha();
    await store.set(setAllSkillsCommitSha$, commitSha, context.signal);
    setupGitRefsHandler(commitSha);
    const skipResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(skipResponse.body).toStrictEqual({
      success: true,
      commitSha,
      synced: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: 0,
    });
  });
});

describe("BDD GET /api/cron/sync-skills — initial sync chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(async () => {
    clearMockedEnv();
    await store.set(cleanupOfficialTestSkills$, undefined, context.signal);
  });

  it("gwt-wt-wt: 200 syncs new skills from tarball + 200 excludes dirs without SKILL.md + 200 skips malformed frontmatter", async () => {
    // Given: a remote tarball with all seed skills + 2
    // extras (alpha + beta).

    // When + Then: 200 — synced + skipped > 0 + alpha
    // skill + storage rows are persisted.
    const commitSha = newCommitSha();
    setupMswHandlers(
      commitSha,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    const syncResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(syncResponse.body.success).toBeTruthy();
    expect(syncResponse.body.commitSha).toBe(commitSha);
    expect(
      syncResponse.body.synced + syncResponse.body.skipped,
    ).toBeGreaterThan(0);
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

    // Given: a remote tarball that includes a directory
    // without SKILL.md.

    // When + Then: 200 — total reflects seed skills +
    // 2 extras + the no-SKILL.md directory is not
    // persisted as a skill.
    const noSkillMdCommit = newCommitSha();
    const nonSkillDirectory = {
      name: `${TEST_SKILL_PREFIX}-no-skill-md`,
      files: [{ path: "README.md", content: "Not a skill." }],
    };
    setupMswHandlers(
      noSkillMdCommit,
      createFullTarball([
        EXTRA_SKILLS.alphaSkill,
        EXTRA_SKILLS.betaSkill,
        nonSkillDirectory,
      ]),
    );
    const noSkillMdResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(noSkillMdResponse.body.total).toBe(ALL_SEED_SKILL_NAMES.length + 2);
    await expect(
      findSkillByUrl(testSkillUrl(nonSkillDirectory.name)),
    ).resolves.toBeNull();

    // Given: a remote tarball with one bad-YAML skill
    // + one good extra.

    // When + Then: 200 — failed=1 + the bad-YAML skill
    // is not persisted + the good extra is persisted.
    const badYamlCommit = newCommitSha();
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
      badYamlCommit,
      createFullTarball([EXTRA_SKILLS.alphaSkill, badSkill]),
    );
    const badYamlResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(badYamlResponse.body.failed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.alphaSkill.name)),
    ).resolves.not.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(badSkill.name)),
    ).resolves.toBeNull();
  });
});

describe("BDD GET /api/cron/sync-skills — incremental sync + cleanup chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(async () => {
    clearMockedEnv();
    await store.set(cleanupOfficialTestSkills$, undefined, context.signal);
  });

  it("gwt-wt-wt: 200 uploads only changed skills → 200 removes skills + S3 objects → 200 keeps DB orphan removal when S3 fails", async () => {
    // Given: an initial sync with alpha + beta skills.

    // When: the second sync changes alpha only.

    // Then: 200 — commitSha updates + synced=1 +
    // skipped>=1 + exactly 2 PutObject commands (one
    // per changed file) + alpha's frontmatter is
    // updated.
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
    const incrementalResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(incrementalResponse.body.commitSha).toBe(nextCommitSha);
    expect(incrementalResponse.body.synced).toBe(1);
    expect(incrementalResponse.body.skipped).toBeGreaterThanOrEqual(1);
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

    // Given: an initial sync with alpha + beta + a
    // mocked S3 ListObjectsV2 returning 2 keys + a
    // second sync with alpha only.

    // When + Then: 200 — removed=1 + beta is removed
    // from the DB + alpha is still present + the S3
    // DeleteObjects command is sent for the 2 listed
    // keys under the test bucket.
    const removeFirstCommit = newCommitSha();
    setupMswHandlers(
      removeFirstCommit,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    setupS3ListObjects(["mock/archive.tar.gz", "mock/manifest.json"]);
    const removeNextCommit = newCommitSha();
    setupMswHandlers(
      removeNextCommit,
      createFullTarball([EXTRA_SKILLS.alphaSkill]),
    );
    const removeResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(removeResponse.body.removed).toBe(1);
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

    // Given: an initial sync with alpha + beta + a
    // mocked S3 ListObjectsV2 that rejects with an
    // error + a second sync with alpha only.

    // When + Then: 200 — removed=1 + the beta skill is
    // removed from the DB despite the S3 cleanup
    // failure.
    const failingFirstCommit = newCommitSha();
    setupMswHandlers(
      failingFirstCommit,
      createFullTarball([EXTRA_SKILLS.alphaSkill, EXTRA_SKILLS.betaSkill]),
    );
    await accept(apiClient().sync({ headers: cronHeaders() }), [200]);

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.reject(new Error("S3 connection failed"));
      }
      return Promise.resolve({});
    });
    const failingNextCommit = newCommitSha();
    setupMswHandlers(
      failingNextCommit,
      createFullTarball([EXTRA_SKILLS.alphaSkill]),
    );
    const failingResponse = await accept(
      apiClient().sync({ headers: cronHeaders() }),
      [200],
    );
    expect(failingResponse.body.removed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(EXTRA_SKILLS.betaSkill.name)),
    ).resolves.toBeNull();
  });
});

describe("BDD GET /api/cron/sync-skills — seed-skills audit chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(async () => {
    clearMockedEnv();
    await store.set(cleanupOfficialTestSkills$, undefined, context.signal);
  });

  it("gwt-wt-wt: 200 logs when SEED_SKILLS references skills not in the source repo", async () => {
    // Given: AXIOM envs + a remote tarball that omits
    // 2 SEED_SKILLS.

    // When: a sync runs.

    // Then: axiomLogging.error is called with the
    // "SEED_SKILLS references skills not found" message
    // and the missing-skill context.
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
  });
});
