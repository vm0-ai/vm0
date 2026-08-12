import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
} from "@vm0/core/github-url";
import { getSkillStorageName } from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { readStrictTarGzip } from "./helpers/strict-tar-gzip";
import {
  cleanupOwnedSkillsState,
  findSkillByUrlState,
  findSystemStorageByNameState,
  seedCurrentSkillVersionsState,
  setOwnedSkillsCommitShaState,
  syncOwnedSkillsState,
} from "./helpers/cron-sync-skills-state";

const context = testContext();
const BUCKET = "test-user-storages";
const STALE_PRESEEDED_COMMIT_SHA = "0".repeat(40);
const SYSTEM_SKILL_ARCHIVE_FORMAT_MARKER = createHash("sha256")
  .update("system-skill-archive-format:ustar-1")
  .digest("hex")
  .slice(0, 16);

interface MockSkillEntry {
  readonly name: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly declaredSize?: number;
  }[];
}

interface MockSkillVersion {
  readonly name: string;
  readonly url: string;
  readonly fullPath: string;
  readonly storageName: string;
  readonly versionHash: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
  };
}

interface CronSyncSkillsFixture {
  readonly skillNamePrefix: string;
  readonly requiredSeedSkillNames: readonly string[];
  readonly existingSkillName: string;
  readonly sentinelSkillName: string;
  readonly alphaSkill: MockSkillEntry;
  readonly betaSkill: MockSkillEntry;
  readonly skillUrls: Set<string>;
  readonly storageNames: Set<string>;
}

function createCronSyncSkillsFixture(): CronSyncSkillsFixture {
  const fixtureId = randomUUID().replaceAll("-", "");
  const skillNamePrefix = `api-test-skill-${fixtureId}-`;
  const alphaName = `${skillNamePrefix}alpha`;
  const betaName = `${skillNamePrefix}beta`;
  return {
    skillNamePrefix,
    requiredSeedSkillNames: SEED_SKILLS.map((name) => {
      return `${skillNamePrefix}${name}`;
    }),
    existingSkillName: `${skillNamePrefix}existing`,
    sentinelSkillName: `api-test-sentinel-${fixtureId}-existing`,
    alphaSkill: {
      name: alphaName,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${alphaName}`,
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
      name: betaName,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${betaName}`,
            "description: Beta integration",
            "---",
            "",
            "# Beta Skill",
          ].join("\n"),
        },
      ],
    },
    skillUrls: new Set(),
    storageNames: new Set(),
  };
}

function registerOwnedSkill(
  fixture: CronSyncSkillsFixture,
  name: string,
  ownsStorage: boolean,
): {
  readonly name: string;
  readonly url: string;
  readonly fullPath: string;
  readonly frontmatter: { readonly name: string; readonly description: string };
} {
  const url = testSkillUrl(name);
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${name}`;
  fixture.skillUrls.add(url);
  if (ownsStorage) {
    fixture.storageNames.add(getSkillStorageName(fullPath));
  }
  return {
    name,
    url,
    fullPath,
    frontmatter: { name, description: `${name} skill` },
  };
}

function registerOwnedEntries(
  fixture: CronSyncSkillsFixture,
  entries: readonly MockSkillEntry[],
): void {
  for (const entry of entries) {
    registerOwnedSkill(fixture, entry.name, true);
  }
}

async function cleanupOwnedSkills(
  fixture: CronSyncSkillsFixture,
): Promise<void> {
  if (fixture.skillUrls.size === 0 && fixture.storageNames.size === 0) {
    return;
  }
  await cleanupOwnedSkillsState(context, {
    skillUrls: [...fixture.skillUrls],
    storageNames: [...fixture.storageNames],
  });
}

async function setOwnedSkillsCommitSha(
  fixture: CronSyncSkillsFixture,
  commitSha: string,
  skillNames: readonly string[] = [fixture.existingSkillName],
): Promise<void> {
  await setOwnedSkillsCommitShaState(context, {
    skills: skillNames.map((name) => {
      return registerOwnedSkill(fixture, name, false);
    }),
    commitSha,
    versionHashMarker: SYSTEM_SKILL_ARCHIVE_FORMAT_MARKER,
  });
}

async function syncOwnedSkills(fixture: CronSyncSkillsFixture) {
  return await syncOwnedSkillsState(context, {
    skillNamePrefix: fixture.skillNamePrefix,
    requiredSkillNames: fixture.requiredSeedSkillNames,
  });
}

async function seedCurrentSkillVersions(
  fixture: CronSyncSkillsFixture,
  entries: readonly MockSkillEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  registerOwnedEntries(fixture, entries);
  await seedCurrentSkillVersionsState(context, {
    staleCommitSha: STALE_PRESEEDED_COMMIT_SHA,
    versions: entries.map((entry) => {
      const version = buildMockSkillVersion(fixture, entry);
      return {
        name: version.name,
        url: version.url,
        full_path: version.fullPath,
        storage_name: version.storageName,
        version_hash: version.versionHash,
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

function seedSkillEntries(fixture: CronSyncSkillsFixture): MockSkillEntry[] {
  return fixture.requiredSeedSkillNames.map((name) => {
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
  fixture: CronSyncSkillsFixture,
  extras: readonly MockSkillEntry[],
): readonly MockSkillEntry[] {
  return createSkillTree(fixture, [...seedSkillEntries(fixture), ...extras]);
}

function createSkillTree(
  fixture: CronSyncSkillsFixture,
  entries: readonly MockSkillEntry[],
): readonly MockSkillEntry[] {
  registerOwnedEntries(fixture, entries);
  return entries;
}

function buildMockSkillVersion(
  fixture: CronSyncSkillsFixture,
  skill: MockSkillEntry,
): MockSkillVersion {
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skill.name}`;
  const storageName = getSkillStorageName(fullPath);
  fixture.storageNames.add(storageName);
  const versionHash = computeMockSkillVersionHash(skill);
  return {
    name: skill.name,
    url: testSkillUrl(skill.name),
    fullPath,
    storageName,
    versionHash,
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
  const formatVersion = "ustar-1";
  const contentHash = createHash("sha256")
    .update(
      `system-skill:${formatVersion}:${testSkillUrl(skill.name)}\n${fileEntries.join("\n")}`,
    )
    .digest("hex");
  return `${SYSTEM_SKILL_ARCHIVE_FORMAT_MARKER}${contentHash.slice(SYSTEM_SKILL_ARCHIVE_FORMAT_MARKER.length)}`;
}

function mockSkillFileContent(skill: MockSkillEntry, path: string): string {
  const file = skill.files.find((candidate) => {
    return candidate.path === path;
  });
  if (!file) {
    throw new Error(`Mock skill file not found: ${path}`);
  }
  return file.content;
}

async function seedCurrentSeedSkillVersions(
  fixture: CronSyncSkillsFixture,
): Promise<void> {
  await seedCurrentSkillVersions(fixture, seedSkillEntries(fixture));
}

function useCronSyncSkillsFixture(): CronSyncSkillsFixture {
  const fixture = createCronSyncSkillsFixture();
  onTestFinished(async () => {
    await cleanupOwnedSkills(fixture);
  });
  return fixture;
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
                size: file.declaredSize ?? Buffer.byteLength(file.content),
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

function successfulS3Response(_command: unknown): Promise<unknown> {
  return Promise.resolve({});
}

function uploadedBodyForKeySuffix(keySuffix: string): Buffer {
  const command = s3CallsByName("PutObjectCommand").find((candidate) => {
    const key = commandInput(candidate).Key;
    return typeof key === "string" && key.endsWith(keySuffix);
  });
  const body = commandInput(command).Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error("Expected a buffered upload body");
  }
  return body;
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
  readonly name: string;
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
  readonly s3Prefix: string;
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
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", undefined);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockImplementation(successfulS3Response);
  });

  it("skips sync when the stored commit SHA is unchanged", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const sentinelCommitSha = newCommitSha();
    await setOwnedSkillsCommitSha(fixture, sentinelCommitSha, [
      fixture.sentinelSkillName,
    ]);
    await setOwnedSkillsCommitSha(fixture, commitSha);
    setupGitRefsHandler(commitSha);

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      remaining: 0,
      total: 0,
    });
    await expect(
      findSkillByUrl(testSkillUrl(fixture.sentinelSkillName)),
    ).resolves.toMatchObject({ commitSha: sentinelCommitSha });
  });

  it("rebuilds legacy archives when the stored commit SHA is unchanged", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const skill = fixture.alphaSkill;
    const currentVersion = buildMockSkillVersion(fixture, skill);
    const legacyVersionHash = createHash("sha256")
      .update(`legacy:${currentVersion.versionHash}`)
      .digest("hex");
    await seedCurrentSkillVersionsState(context, {
      staleCommitSha: commitSha,
      versions: [
        {
          name: currentVersion.name,
          url: currentVersion.url,
          full_path: currentVersion.fullPath,
          storage_name: currentVersion.storageName,
          version_hash: legacyVersionHash,
          size: currentVersion.size,
          archive_size: currentVersion.archiveSize,
          file_count: currentVersion.fileCount,
          frontmatter: currentVersion.frontmatter,
        },
      ],
    });
    setupMswHandlers(commitSha, createFullSkillTree(fixture, [skill]));

    const response = await syncOwnedSkills(fixture);

    expect(response).toMatchObject({
      success: true,
      commitSha,
      synced: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 1,
    });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(8);
    await expect(findSkillByUrl(currentVersion.url)).resolves.toMatchObject({
      commitSha,
      versionHash: currentVersion.versionHash,
    });
  });

  it("syncs new skills from the repository tree", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      commitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 2,
      skipped: fixture.requiredSeedSkillNames.length,
      failed: 0,
      removed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });

    const alphaSkill = await findSkillByUrl(
      testSkillUrl(fixture.alphaSkill.name),
    );
    expect(alphaSkill).toMatchObject({
      name: fixture.alphaSkill.name,
      fullPath: `vm0-ai/vm0-skills/tree/main/${fixture.alphaSkill.name}`,
      commitSha,
      fileCount: 2,
      frontmatter: {
        name: fixture.alphaSkill.name,
        description: "Alpha integration skill",
      },
    });
    expect(alphaSkill?.versionHash).toBe(
      buildMockSkillVersion(fixture, fixture.alphaSkill).versionHash,
    );

    const alphaStorage = await findSystemStorageByName(
      getSkillStorageName(
        `vm0-ai/vm0-skills/tree/main/${fixture.alphaSkill.name}`,
      ),
    );
    if (!alphaStorage) {
      throw new Error("Expected the alpha skill storage");
    }
    const alphaVersion = buildMockSkillVersion(fixture, fixture.alphaSkill);
    const alphaArchiveKey = `${alphaStorage.s3Prefix}/${alphaVersion.versionHash}/archive.tar.gz`;
    const alphaArchiveUpload = s3CallsByName("PutObjectCommand").find(
      (command) => {
        return commandInput(command).Key === alphaArchiveKey;
      },
    );
    expect(alphaArchiveUpload).toBeDefined();
    const alphaArchive = uploadedBodyForKeySuffix(
      `/${alphaVersion.versionHash}/archive.tar.gz`,
    );
    const alphaArchiveSize = alphaArchive.length;
    const alphaArchiveFiles = readStrictTarGzip(alphaArchive);
    expect([...alphaArchiveFiles.keys()]).toStrictEqual([
      "index.ts",
      "SKILL.md",
    ]);
    expect(alphaArchiveFiles.get("SKILL.md")?.toString()).toBe(
      mockSkillFileContent(fixture.alphaSkill, "SKILL.md"),
    );
    expect(alphaArchiveFiles.get("index.ts")?.toString()).toBe(
      mockSkillFileContent(fixture.alphaSkill, "index.ts"),
    );
    expect(alphaStorage).toMatchObject({
      headVersionId: alphaVersion.versionHash,
      size: alphaVersion.size,
      versionSize: alphaVersion.size,
      archiveSize: alphaArchiveSize,
    });
    expect(alphaArchiveSize).toBeGreaterThan(0);
    expect(
      s3CallsByName("PutObjectCommand").map((command) => {
        return commandInput(command).Key;
      }),
    ).toContain(
      `${alphaStorage.s3Prefix}/${alphaVersion.versionHash}/manifest.json`,
    );
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(4);
  });

  it("converges a large skill catalog across bounded invocations", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const extraSkills = Array.from({ length: 10 }, (_, index) => {
      const name = `${fixture.skillNamePrefix}batch-${index.toString().padStart(2, "0")}`;
      return {
        name,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
          },
        ],
      } satisfies MockSkillEntry;
    });
    setupMswHandlers(commitSha, createFullSkillTree(fixture, extraSkills));

    const first = await syncOwnedSkills(fixture);
    expect(first).toMatchObject({
      success: true,
      commitSha,
      failed: 0,
      remaining: 5,
      total: fixture.requiredSeedSkillNames.length + 10,
    });
    expect(first.synced + first.skipped).toBe(8);

    const second = await syncOwnedSkills(fixture);
    expect(second).toMatchObject({
      success: true,
      commitSha,
      synced: 5,
      failed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 10,
    });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(26);

    const current = await syncOwnedSkills(fixture);
    expect(current).toMatchObject({
      success: true,
      commitSha,
      synced: 0,
      remaining: 0,
      total: 0,
    });

    context.mocks.s3.send.mockClear();
    const nextCommitSha = newCommitSha();
    const modifiedExtraSkills = extraSkills.map((skill) => {
      return {
        ...skill,
        files: skill.files.map((file) => {
          return { ...file, content: `${file.content}\nUpdated.` };
        }),
      } satisfies MockSkillEntry;
    });
    setupMswHandlers(
      nextCommitSha,
      createFullSkillTree(fixture, modifiedExtraSkills),
    );

    const changedFirst = await syncOwnedSkills(fixture);
    expect(changedFirst).toMatchObject({
      commitSha: nextCommitSha,
      synced: 8,
      failed: 0,
      remaining: 2,
    });
    const changedSecond = await syncOwnedSkills(fixture);
    expect(changedSecond).toMatchObject({
      commitSha: nextCommitSha,
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(20);
  });

  it("authenticates public tree requests with OAuth client credentials", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const sourceSkills = createFullSkillTree(fixture, [fixture.alphaSkill]);
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(commitSha, sourceSkills);
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "github-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "github-client-secret");
    server.use(
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0-skills/git/trees/:commitSha",
        ({ params, request }) => {
          expect(request.headers.get("authorization")).toBe(
            `Basic ${Buffer.from("github-client-id:github-client-secret").toString("base64")}`,
          );
          const treeCommitSha = String(params.commitSha);
          return HttpResponse.json({
            sha: treeCommitSha,
            truncated: false,
            tree: sourceSkills.flatMap((skill) => {
              return skill.files.map((file) => {
                return {
                  path: `${skill.name}/${file.path}`,
                  type: "blob",
                  sha: mockGitBlobSha(file.content),
                  size: Buffer.byteLength(file.content),
                };
              });
            }),
          });
        },
      ),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response.failed).toBe(0);
    expect(response.commitSha).toBe(commitSha);
  });

  it("syncs isolated counterparts for the current default seed skills", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    setupMswHandlers(commitSha, createFullSkillTree(fixture, []));
    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: fixture.requiredSeedSkillNames.length,
      skipped: 0,
      failed: 0,
      removed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length,
    });
    const syncedSkills = await Promise.all(
      fixture.requiredSeedSkillNames.map((name) => {
        return findSkillByUrl(testSkillUrl(name));
      }),
    );
    expect(
      syncedSkills.map((skill) => {
        return skill?.name;
      }),
    ).toStrictEqual(fixture.requiredSeedSkillNames);
    expect(
      new Set(
        syncedSkills.map((skill) => {
          return skill?.versionHash;
        }),
      ).size,
    ).toBe(fixture.requiredSeedSkillNames.length);

    const storages = await Promise.all(
      fixture.requiredSeedSkillNames.map((name) => {
        const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${name}`;
        return findSystemStorageByName(getSkillStorageName(fullPath));
      }),
    );
    const objectPrefixes = storages.map((storage) => {
      if (!storage) {
        throw new Error("Expected an isolated seed skill storage");
      }
      return storage.s3Prefix;
    });
    expect(new Set(objectPrefixes).size).toBe(
      fixture.requiredSeedSkillNames.length,
    );
  });

  it("excludes repository directories without a SKILL.md file", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const nonSkillDirectory = {
      name: `${fixture.skillNamePrefix}no-skill-md`,
      files: [{ path: "README.md", content: "Not a skill." }],
    };
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      commitSha,
      createFullSkillTree(fixture, [
        fixture.alphaSkill,
        fixture.betaSkill,
        nonSkillDirectory,
      ]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 2,
      skipped: fixture.requiredSeedSkillNames.length,
      failed: 0,
      removed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    await expect(
      findSkillByUrl(testSkillUrl(nonSkillDirectory.name)),
    ).resolves.toBeNull();
  });

  it("skips malformed skill frontmatter and syncs other skills", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const badSkillName = `${fixture.skillNamePrefix}bad-yaml`;
    const badSkill = {
      name: badSkillName,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${badSkillName}`,
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
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      commitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill, badSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 1,
      skipped: fixture.requiredSeedSkillNames.length,
      failed: 1,
      removed: 0,
      remaining: 1,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.not.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(badSkill.name)),
    ).resolves.toBeNull();
  });

  it("rejects a skill whose declared content cannot fit the Worker bound", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const oversizedSkillName = `${fixture.skillNamePrefix}oversized`;
    const oversizedSkill = {
      name: oversizedSkillName,
      files: [
        {
          path: "SKILL.md",
          content:
            `---\nname: ${oversizedSkillName}\n` +
            "description: Oversized skill\n---\n",
          declaredSize: 8 * 1024 * 1024 + 1,
        },
      ],
    } satisfies MockSkillEntry;
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(commitSha, createFullSkillTree(fixture, [oversizedSkill]));

    const firstResponse = await syncOwnedSkills(fixture);
    expect(firstResponse).toMatchObject({ failed: 0, remaining: 1 });

    const response = await syncOwnedSkills(fixture);
    expect(response).toMatchObject({ failed: 1, remaining: 1 });
    await expect(
      findSkillByUrl(testSkillUrl(oversizedSkill.name)),
    ).resolves.toBeNull();
  });

  it("retries a transient skill download failure at the same commit", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const sourceSkills = createFullSkillTree(fixture, [fixture.alphaSkill]);
    const alphaSkillMd = fixture.alphaSkill.files.find((file) => {
      return file.path === "SKILL.md";
    });
    if (!alphaSkillMd) {
      throw new Error("Expected the alpha SKILL.md fixture");
    }
    setupMswHandlers(commitSha, sourceSkills);
    let alphaSkillMdRequests = 0;
    server.use(
      http.get(
        `https://raw.githubusercontent.com/vm0-ai/vm0-skills/${commitSha}/${fixture.alphaSkill.name}/SKILL.md`,
        () => {
          alphaSkillMdRequests++;
          if (alphaSkillMdRequests === 1) {
            return new HttpResponse(null, { status: 503 });
          }
          return new HttpResponse(alphaSkillMd.content);
        },
      ),
    );

    const failedResponse = await syncOwnedSkills(fixture);
    expect(failedResponse.failed).toBe(1);
    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.toBeNull();
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(6);

    const retriedResponse = await syncOwnedSkills(fixture);
    expect(retriedResponse.failed).toBe(0);
    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.toMatchObject({ commitSha });
  });

  it("only uploads changed skills during incremental sync", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await syncOwnedSkills(fixture);

    context.mocks.s3.send.mockClear();
    const nextCommitSha = newCommitSha();
    const modifiedAlpha = {
      name: fixture.alphaSkill.name,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${fixture.alphaSkill.name}`,
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
      createFullSkillTree(fixture, [modifiedAlpha, fixture.betaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha: nextCommitSha,
      synced: 1,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);

    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.toMatchObject({
      commitSha: nextCommitSha,
      frontmatter: {
        name: fixture.alphaSkill.name,
        description: "Updated alpha skill",
      },
    });
  });

  it("removes skills deleted from the source repository and cleans S3 objects", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await syncOwnedSkills(fixture);

    context.mocks.s3.send.mockClear();
    const betaVersion = buildMockSkillVersion(fixture, fixture.betaSkill);
    const betaStorage = await findSystemStorageByName(betaVersion.storageName);
    if (!betaStorage) {
      throw new Error("Expected the beta skill storage");
    }
    const betaObjectKeys = [
      `${betaStorage.s3Prefix}/${betaVersion.versionHash}/archive.tar.gz`,
      `${betaStorage.s3Prefix}/${betaVersion.versionHash}/manifest.json`,
    ];
    setupS3ListObjects(betaObjectKeys);
    const sentinelCommitSha = newCommitSha();
    await setOwnedSkillsCommitSha(fixture, sentinelCommitSha, [
      fixture.sentinelSkillName,
    ]);
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha: nextCommitSha,
      synced: 0,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 1,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 1,
    });
    await expect(
      findSkillByUrl(testSkillUrl(fixture.betaSkill.name)),
    ).resolves.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.not.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(fixture.sentinelSkillName)),
    ).resolves.toMatchObject({ commitSha: sentinelCommitSha });

    const deleteCommand = s3CallsByName("DeleteObjectsCommand")[0];
    expect(commandInput(deleteCommand)).toMatchObject({
      Bucket: BUCKET,
      Delete: {
        Objects: betaObjectKeys.map((key) => {
          return { Key: key };
        }),
      },
    });
  });

  it("keeps DB orphan removal when S3 cleanup fails", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await syncOwnedSkills(fixture);

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.reject(new Error("S3 connection failed"));
      }
      return successfulS3Response(command);
    });
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullSkillTree(fixture, [fixture.alphaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha: nextCommitSha,
      synced: 0,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 1,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length + 1,
    });
    await expect(
      findSkillByUrl(testSkillUrl(fixture.betaSkill.name)),
    ).resolves.toBeNull();
  });

  it("logs missing required skills and restores them after a source rollback", async () => {
    const fixture = useCronSyncSkillsFixture();
    mockEnv("AXIOM_TOKEN_TELEMETRY", "test-token");
    mockEnv("AXIOM_DATASET_SUFFIX", "dev");
    const omittedSkills = fixture.requiredSeedSkillNames.slice(0, 2);
    const omittedSkillSet = new Set(omittedSkills);
    const keptSkills = fixture.requiredSeedSkillNames.filter((name) => {
      return !omittedSkillSet.has(name);
    });
    const initialCommitSha = newCommitSha();
    setupMswHandlers(initialCommitSha, createFullSkillTree(fixture, []));
    await syncOwnedSkills(fixture);

    const removalCommitSha = newCommitSha();
    setupMswHandlers(
      removalCommitSha,
      createSkillTree(
        fixture,
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

    const removalResponse = await syncOwnedSkills(fixture);

    expect(removalResponse).toStrictEqual({
      success: true,
      commitSha: removalCommitSha,
      synced: 0,
      skipped: keptSkills.length,
      failed: 0,
      removed: omittedSkills.length,
      remaining: 0,
      total: keptSkills.length,
    });
    await Promise.all(
      omittedSkills.map(async (name) => {
        await expect(findSkillByUrl(testSkillUrl(name))).resolves.toBeNull();
      }),
    );

    expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
      expect.stringContaining("SEED_SKILLS references skills not found"),
      expect.objectContaining({
        context: "skills:sync",
        missingSkills: omittedSkills.map((name) => {
          return testSkillUrl(name);
        }),
      }),
    );

    setupMswHandlers(initialCommitSha, createFullSkillTree(fixture, []));
    const rollbackResponse = await syncOwnedSkills(fixture);

    expect(rollbackResponse).toStrictEqual({
      success: true,
      commitSha: initialCommitSha,
      synced: omittedSkills.length,
      skipped: keptSkills.length,
      failed: 0,
      removed: 0,
      remaining: 0,
      total: fixture.requiredSeedSkillNames.length,
    });
    await Promise.all(
      omittedSkills.map(async (name) => {
        await expect(findSkillByUrl(testSkillUrl(name))).resolves.toMatchObject(
          { commitSha: initialCommitSha },
        );
      }),
    );
  });
});
