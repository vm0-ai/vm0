import { randomUUID } from "node:crypto";

import {
  storagesDownloadContract,
  storagesListContract,
} from "@vm0/api-contracts/contracts/storages";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signPatJwtForTests, signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

type StorageType = "volume" | "artifact";

interface StorageListResponseItem {
  readonly name: string;
}

interface VersionSeed {
  readonly id?: string;
  readonly fileCount?: number;
  readonly size?: number;
  readonly s3Key?: string;
}

interface SeedStorageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly name?: string;
  readonly type?: StorageType;
  readonly versions?: readonly VersionSeed[];
  readonly updatedAt?: Date;
}

interface StorageFixture {
  readonly orgId: string;
  readonly storageId: string;
  readonly name: string;
  readonly versionIds: readonly string[];
}

interface PatFixture {
  readonly orgId: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly token: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function listClient() {
  return setupApp({ context })(storagesListContract);
}

function downloadClient() {
  return setupApp({ context })(storagesDownloadContract);
}

function storageName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function versionId(prefix = ""): string {
  const suffix = randomUUID().replaceAll("-", "");
  return `${prefix}${suffix}`.padEnd(64, "0").slice(0, 64);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

function s3CommandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

async function deleteStorageFixture(fixture: StorageFixture): Promise<void> {
  const db = store.set(writeDb$);
  const storageRows = await db
    .select({ id: storages.id })
    .from(storages)
    .where(eq(storages.orgId, fixture.orgId));
  const storageIds = storageRows.map((row) => {
    return row.id;
  });

  await db
    .update(storages)
    .set({ headVersionId: null })
    .where(eq(storages.orgId, fixture.orgId));

  if (storageIds.length > 0) {
    await db
      .delete(storageVersions)
      .where(inArray(storageVersions.storageId, storageIds));
  }

  await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
}

async function deletePatFixture(fixture: PatFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, fixture.orgId),
        eq(orgMembersCache.userId, fixture.userId),
      ),
    );
  await db.delete(cliTokens).where(eq(cliTokens.id, fixture.tokenId));
}

const trackStorage = createFixtureTracker<StorageFixture>(deleteStorageFixture);
const trackPat = createFixtureTracker<PatFixture>(deletePatFixture);
const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function seedPatFixture(): Promise<PatFixture> {
  const tokenId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const seconds = currentSecond();
  const token = signPatJwtForTests({
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: seconds,
    exp: seconds + 60,
  });
  const db = store.set(writeDb$);

  await db.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "test token",
    expiresAt: new Date(now() + 60_000),
  });
  await db.insert(orgMembersCache).values({
    orgId,
    userId,
    role: "admin",
    cachedAt: new Date(now()),
  });

  return { orgId, tokenId, userId, token };
}

async function seedStorage(args: SeedStorageArgs): Promise<StorageFixture> {
  const db = store.set(writeDb$);
  const type = args.type ?? "artifact";
  const name = args.name ?? storageName(type);
  const storageId = randomUUID();
  const scopedUserId = type === "volume" ? VOLUME_ORG_USER_ID : args.userId;
  const versions = args.versions ?? [];
  const versionIds: string[] = [];

  await db.insert(storages).values({
    id: storageId,
    orgId: args.orgId,
    userId: scopedUserId,
    name,
    type,
    s3Prefix: `storages/${storageId}`,
    updatedAt: args.updatedAt,
  });

  for (const version of versions) {
    const id = version.id ?? versionId();
    versionIds.push(id);
    await db.insert(storageVersions).values({
      id,
      storageId,
      s3Key: version.s3Key ?? `storages/${storageId}/${id}`,
      size: version.size ?? 100,
      fileCount: version.fileCount ?? 1,
      createdBy: args.userId,
    });
  }

  const headVersion = versions.at(-1);
  const headVersionId = versionIds.at(-1);
  if (headVersion && headVersionId) {
    await db
      .update(storages)
      .set({
        headVersionId,
        size: headVersion.size ?? 100,
        fileCount: headVersion.fileCount ?? 1,
      })
      .where(eq(storages.id, storageId));
  }

  return { orgId: args.orgId, storageId, name, versionIds };
}

async function seedRunScopedFixture(): Promise<
  UsageInsightFixture & { readonly runId: string }
> {
  const fixture = await trackUsage(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const compose = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const run = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: compose.composeId,
    },
    context.signal,
  );
  return { ...fixture, runId: run.runId };
}

describe("GET /api/storages/list", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await listClient().list({
      query: { type: "artifact" },
      headers: {},
    });

    expect(response.status).toBe(401);
    if (response.status !== 401) {
      return;
    }
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for an invalid type query", async () => {
    const response = await listClient().list({
      query: { type: "invalid" } as never,
      headers: authHeaders(),
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      return;
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("type");
  });

  it("returns an empty array when no storages exist", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await listClient().list({
      query: { type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toStrictEqual([]);
  });

  it("lists artifacts for the authenticated user ordered by update time", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const older = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "older-artifact",
        type: "artifact",
        versions: [{ size: 20, fileCount: 2 }],
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      }),
    );
    const newer = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "newer-artifact",
        type: "artifact",
        versions: [{ size: 30, fileCount: 3 }],
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const response = await listClient().list({
      query: { type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(
      response.body.map((item: StorageListResponseItem) => {
        return item.name;
      }),
    ).toStrictEqual([newer.name, older.name]);
    expect(response.body[0]).toMatchObject({
      name: newer.name,
      size: 30,
      fileCount: 3,
      updatedAt: "2025-01-02T00:00:00.000Z",
    });
  });

  it("isolates artifact listings by authenticated user and organization", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const visible = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "visible-artifact",
        type: "artifact",
        versions: [{ size: 20, fileCount: 2 }],
      }),
    );
    await trackStorage(
      seedStorage({
        orgId,
        userId: `user_${randomUUID()}`,
        name: "same-org-other-user-artifact",
        type: "artifact",
        versions: [{ size: 30, fileCount: 3 }],
      }),
    );
    await trackStorage(
      seedStorage({
        orgId: `org_${randomUUID()}`,
        userId,
        name: "other-org-same-user-artifact",
        type: "artifact",
        versions: [{ size: 40, fileCount: 4 }],
      }),
    );

    const response = await listClient().list({
      query: { type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(
      response.body.map((item: StorageListResponseItem) => {
        return item.name;
      }),
    ).toStrictEqual([visible.name]);
  });

  it("accepts PAT tokens without storage-specific capabilities", async () => {
    const pat = await trackPat(seedPatFixture());
    const artifact = await trackStorage(
      seedStorage({
        orgId: pat.orgId,
        userId: pat.userId,
        name: "pat-artifact",
        type: "artifact",
        versions: [{ size: 25, fileCount: 2 }],
      }),
    );

    const response = await listClient().list({
      query: { type: "artifact" },
      headers: { authorization: `Bearer ${pat.token}` },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.name).toBe(artifact.name);
  });

  it("lists volumes with org-level storage ownership and filters out artifacts", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const volume = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "shared-volume",
        type: "volume",
        versions: [{ size: 40, fileCount: 4 }],
      }),
    );
    await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "my-artifact",
        type: "artifact",
        versions: [{ size: 50, fileCount: 5 }],
      }),
    );

    const response = await listClient().list({
      query: { type: "volume" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.name).toBe(volume.name);
  });

  it("scopes sandbox tokens through the run organization", async () => {
    const fixture = await seedRunScopedFixture();
    await trackStorage(
      seedStorage({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "sandbox-artifact",
        type: "artifact",
        versions: [{ size: 60, fileCount: 6 }],
      }),
    );
    const token = sandboxToken(fixture);

    const response = await listClient().list({
      query: { type: "artifact" },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.name).toBe("sandbox-artifact");
  });

  it("lists volumes for sandbox tokens through the run organization", async () => {
    const fixture = await seedRunScopedFixture();
    await trackStorage(
      seedStorage({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "sandbox-volume",
        type: "volume",
        versions: [{ size: 70, fileCount: 7 }],
      }),
    );
    const token = sandboxToken(fixture);

    const response = await listClient().list({
      query: { type: "volume" },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.name).toBe("sandbox-volume");
  });

  it("returns 404 when the sandbox token run cannot be resolved", async () => {
    const token = sandboxToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: randomUUID(),
    });

    const response = await listClient().list({
      query: { type: "volume" },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
    if (response.status !== 404) {
      return;
    }
    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });
});

describe("GET /api/storages/download", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await downloadClient().download({
      query: { name: "missing", type: "artifact" },
      headers: {},
    });

    expect(response.status).toBe(401);
    if (response.status !== 401) {
      return;
    }
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when required query parameters are missing or invalid", async () => {
    const missingName = await downloadClient().download({
      query: { type: "artifact" } as never,
      headers: authHeaders(),
    });
    expect(missingName.status).toBe(400);
    if (missingName.status !== 400) {
      return;
    }
    expect(missingName.body.error.message).toContain("name");

    const missingType = await downloadClient().download({
      query: { name: "missing" } as never,
      headers: authHeaders(),
    });
    expect(missingType.status).toBe(400);
    if (missingType.status !== 400) {
      return;
    }
    expect(missingType.body.error.message).toContain("type");

    const invalidType = await downloadClient().download({
      query: { name: "missing", type: "invalid" } as never,
      headers: authHeaders(),
    });
    expect(invalidType.status).toBe(400);
    if (invalidType.status !== 400) {
      return;
    }
    expect(invalidType.body.error.message).toContain("type");
  });

  it("returns 404 when storage does not exist", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await downloadClient().download({
      query: { name: storageName("missing"), type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(404);
    if (response.status !== 404) {
      return;
    }
    expect(response.body.error.message).toContain("not found");
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when a sandbox token run is missing", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = randomUUID();
    const token = sandboxToken({ userId, orgId, runId });

    const response = await downloadClient().download({
      query: { name: "missing", type: "artifact" },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
    if (response.status !== 404) {
      return;
    }
    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when storage has no versions", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const storage = await trackStorage(
      seedStorage({ orgId, userId, name: "empty-history", versions: [] }),
    );

    const response = await downloadClient().download({
      query: { name: storage.name, type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(404);
    if (response.status !== 404) {
      return;
    }
    expect(response.body.error.message).toContain("no versions");
  });

  it("returns empty=true for empty storage", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "empty-artifact",
        versions: [{ size: 0, fileCount: 0 }],
      }),
    );

    const response = await downloadClient().download({
      query: { name: storage.name, type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toStrictEqual({
      empty: true,
      versionId: storage.versionIds[0],
      fileCount: 0,
      size: 0,
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("returns a presigned URL for non-empty storage", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://mock-presigned-url",
    );
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "with-files",
        versions: [{ size: 1000, fileCount: 2 }],
      }),
    );

    const response = await downloadClient().download({
      query: { name: storage.name, type: "artifact" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toStrictEqual({
      url: "https://mock-presigned-url",
      versionId: storage.versionIds[0],
      fileCount: 2,
      size: 1000,
    });
    const command = context.mocks.s3.getSignedUrl.mock.calls[0]?.[1];
    expect(s3CommandInput(command).Key).toBe(
      `storages/${storage.storageId}/${storage.versionIds[0]}/archive.tar.gz`,
    );
  });

  it("returns a specific full version when requested", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const firstVersion = versionId();
    const secondVersion = versionId();
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "specific-version",
        versions: [
          { id: firstVersion, size: 500, fileCount: 1 },
          { id: secondVersion, size: 1500, fileCount: 3 },
        ],
      }),
    );

    const response = await downloadClient().download({
      query: {
        name: storage.name,
        type: "artifact",
        version: firstVersion,
      },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({
      versionId: firstVersion,
      fileCount: 1,
      size: 500,
    });
  });

  it("resolves a unique short version prefix", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const fullVersion = versionId("abc12345");
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "prefix-resolve",
        versions: [{ id: fullVersion, size: 700, fileCount: 7 }],
      }),
    );

    const response = await downloadClient().download({
      query: {
        name: storage.name,
        type: "artifact",
        version: "abc12345",
      },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({ versionId: fullVersion });
  });

  it("keeps scientific-notation-looking prefixes as strings", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const fullVersion = versionId("846e3519");
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "sci-notation",
        versions: [{ id: fullVersion, size: 800, fileCount: 8 }],
      }),
    );

    const response = await downloadClient().download({
      query: {
        name: storage.name,
        type: "artifact",
        version: "846e3519",
      },
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({ versionId: fullVersion });
  });

  it("returns 400 when a version prefix is too short or invalid", async () => {
    const tooShort = await downloadClient().download({
      query: {
        name: "missing",
        type: "artifact",
        version: "abcdefg",
      },
      headers: authHeaders(),
    });
    expect(tooShort.status).toBe(400);
    if (tooShort.status !== 400) {
      return;
    }
    expect(tooShort.body.error.message).toContain("8");

    const invalid = await downloadClient().download({
      query: {
        name: "missing",
        type: "artifact",
        version: "ghijklmn",
      },
      headers: authHeaders(),
    });
    expect(invalid.status).toBe(400);
    if (invalid.status !== 400) {
      return;
    }
    expect(invalid.body.error.message).toContain("hex");
  });

  it("returns 400 when a version prefix is ambiguous", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const prefix = "1234abcd";
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "ambiguous-prefix",
        versions: [
          { id: `${prefix}${"0".repeat(56)}`, size: 100, fileCount: 1 },
          { id: `${prefix}${"1".repeat(56)}`, size: 200, fileCount: 2 },
        ],
      }),
    );

    const response = await downloadClient().download({
      query: { name: storage.name, type: "artifact", version: prefix },
      headers: authHeaders(),
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      return;
    }
    expect(response.body.error.message).toContain("Ambiguous");
  });

  it("returns 404 when a valid version prefix has no match", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const storage = await trackStorage(
      seedStorage({
        orgId,
        userId,
        name: "prefix-nomatch",
        versions: [{ id: versionId("99999999"), size: 100, fileCount: 1 }],
      }),
    );

    const response = await downloadClient().download({
      query: { name: storage.name, type: "artifact", version: "00000000" },
      headers: authHeaders(),
    });

    expect(response.status).toBe(404);
    if (response.status !== 404) {
      return;
    }
    expect(response.body.error.message).toContain("not found");
  });
});
