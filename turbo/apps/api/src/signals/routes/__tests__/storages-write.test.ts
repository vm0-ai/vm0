import { randomUUID } from "node:crypto";

import {
  MAX_FILE_SIZE_BYTES,
  storagesCommitContract,
  storagesPrepareContract,
} from "@vm0/api-contracts/contracts/storages";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

const BUCKET = "test-user-storages";
const TEST_HASH = "a".repeat(64);
const SECOND_TEST_HASH = "b".repeat(64);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

type StorageType = "volume" | "artifact";

interface StorageFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface StorageOrgFixture {
  readonly orgId: string;
}

interface AuthFixture extends StorageOrgFixture {
  readonly userId: string;
}

interface PrepareBody {
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly files: StorageFile[];
  readonly force?: boolean;
  readonly runId?: string;
  readonly baseVersion?: string;
  readonly changes?: {
    readonly added: string[];
    readonly modified: string[];
    readonly deleted: string[];
  };
}

interface CommitBody {
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly versionId: string;
  readonly files: StorageFile[];
  readonly runId?: string;
  readonly message?: string;
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function prepareClient() {
  return setupApp({ context })(storagesPrepareContract);
}

function commitClient() {
  return setupApp({ context })(storagesCommitContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function storageName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function validFile(overrides: Partial<StorageFile> = {}): StorageFile {
  return {
    path: "test.txt",
    hash: TEST_HASH,
    size: 100,
    ...overrides,
  };
}

function prepareBody(overrides: Partial<PrepareBody> = {}): PrepareBody {
  return {
    storageName: storageName("artifact"),
    storageType: "artifact",
    files: [validFile()],
    ...overrides,
  };
}

function commitBody(overrides: Partial<CommitBody>): CommitBody {
  return {
    storageName: storageName("artifact"),
    storageType: "artifact",
    versionId: "0".repeat(64),
    files: [validFile()],
    ...overrides,
  };
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

function s3SendInputs(): readonly Record<string, unknown>[] {
  return context.mocks.s3.send.mock.calls.map(([command]) => {
    return s3CommandInput(command);
  });
}

function notFoundError(): Error & {
  name: "NotFound";
  readonly $metadata: { readonly httpStatusCode: 404 };
} {
  const error = new Error("Not found") as Error & {
    name: "NotFound";
    $metadata: { httpStatusCode: 404 };
  };
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

async function deleteStorageOrg(fixture: StorageOrgFixture): Promise<void> {
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

const trackStorageOrg =
  createFixtureTracker<StorageOrgFixture>(deleteStorageOrg);
const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function useClerkSession(): Promise<AuthFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  await trackStorageOrg(Promise.resolve({ orgId }));
  return { userId, orgId };
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

async function prepareOk(body: PrepareBody) {
  const response = await accept(
    prepareClient().prepare({ body, headers: authHeaders() }),
    [200],
  );
  return response.body;
}

async function commitOk(body: CommitBody) {
  const response = await accept(
    commitClient().commit({ body, headers: authHeaders() }),
    [200],
  );
  return response.body;
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
});

describe("POST /api/storages/prepare", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      prepareClient().prepare({ body: prepareBody(), headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid request bodies", async () => {
    await useClerkSession();

    const response = await accept(
      prepareClient().prepare({
        body: { storageType: "artifact", files: [] } as never,
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("storageName");
  });

  it("returns 400 when session auth has no organization context", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody(),
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Explicit org context");
  });

  it("creates storage metadata and returns upload URLs", async () => {
    const auth = await useClerkSession();
    const name = storageName("new-storage");
    const body = prepareBody({ storageName: name });

    const response = await prepareOk(body);

    expect(response.existing).toBeFalsy();
    expect(response.uploads?.archive.key).toBe(
      `${auth.orgId}/artifact/${name}/${response.versionId}/archive.tar.gz`,
    );
    expect(response.uploads?.manifest.key).toBe(
      `${auth.orgId}/artifact/${name}/${response.versionId}/manifest.json`,
    );
    expect(response.uploads?.archive.presignedUrl).toMatch(/^https?:\/\//);

    const db = store.set(writeDb$);
    const [storage] = await db
      .select()
      .from(storages)
      .where(and(eq(storages.orgId, auth.orgId), eq(storages.name, name)))
      .limit(1);
    expect(storage).toMatchObject({
      orgId: auth.orgId,
      userId: auth.userId,
      name,
      type: "artifact",
      size: 0,
      fileCount: 0,
    });
  });

  it("rejects total declared file size over 100MB", async () => {
    await useClerkSession();

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody({
          files: [
            validFile({ path: "one.bin", size: MAX_FILE_SIZE_BYTES }),
            validFile({ path: "two.bin", hash: SECOND_TEST_HASH, size: 1 }),
          ],
        }),
        headers: authHeaders(),
      }),
      [413],
    );

    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 when one file exceeds the per-file size schema limit", async () => {
    await useClerkSession();

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody({
          files: [
            validFile({
              path: "large-file.bin",
              size: MAX_FILE_SIZE_BYTES + 1,
            }),
          ],
        }),
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("computes the same version ID regardless of file order", async () => {
    await useClerkSession();
    const name = storageName("order-independent");
    const filesOrderAB = [
      validFile({ path: "a.txt", hash: TEST_HASH, size: 100 }),
      validFile({ path: "b.txt", hash: SECOND_TEST_HASH, size: 200 }),
    ];
    const filesOrderBA = [...filesOrderAB].reverse();

    const first = await prepareOk(
      prepareBody({ storageName: name, files: filesOrderAB }),
    );
    const second = await prepareOk(
      prepareBody({ storageName: name, files: filesOrderBA }),
    );

    expect(first.versionId).toBe(second.versionId);
  });

  it("computes different version IDs when file content or path changes", async () => {
    await useClerkSession();
    const name = storageName("content-hash");

    const original = await prepareOk(
      prepareBody({
        storageName: name,
        files: [validFile({ path: "data.txt", hash: TEST_HASH, size: 100 })],
      }),
    );
    const changedContent = await prepareOk(
      prepareBody({
        storageName: name,
        files: [
          validFile({
            path: "data.txt",
            hash: SECOND_TEST_HASH,
            size: 100,
          }),
        ],
      }),
    );
    const changedPath = await prepareOk(
      prepareBody({
        storageName: name,
        files: [validFile({ path: "renamed.txt", hash: TEST_HASH, size: 100 })],
      }),
    );

    expect(changedContent.versionId).not.toBe(original.versionId);
    expect(changedPath.versionId).not.toBe(original.versionId);
  });

  it("scopes sandbox tokens through the run organization", async () => {
    const fixture = await seedRunScopedFixture();
    await trackStorageOrg(Promise.resolve({ orgId: fixture.orgId }));
    const token = sandboxToken(fixture);
    const name = storageName("sandbox-storage");

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody({ storageName: name }),
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.uploads?.archive.key).toBe(
      `${fixture.orgId}/artifact/${name}/${response.body.versionId}/archive.tar.gz`,
    );
  });

  it("returns existing=true when the version and S3 files already exist", async () => {
    await useClerkSession();
    const body = prepareBody({ storageName: storageName("existing") });
    const prepared = await prepareOk(body);

    context.mocks.s3.send.mockResolvedValue({});
    await commitOk(
      commitBody({
        storageName: body.storageName,
        storageType: body.storageType,
        versionId: prepared.versionId,
        files: body.files,
      }),
    );

    context.mocks.s3.getSignedUrl.mockClear();
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await prepareOk(body);

    expect(response).toStrictEqual({
      versionId: prepared.versionId,
      existing: true,
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("returns upload URLs when an existing DB version is missing S3 files", async () => {
    await useClerkSession();
    const body = prepareBody({ storageName: storageName("missing-s3") });
    const prepared = await prepareOk(body);

    context.mocks.s3.send.mockResolvedValue({});
    await commitOk(
      commitBody({
        storageName: body.storageName,
        storageType: body.storageType,
        versionId: prepared.versionId,
        files: body.files,
      }),
    );

    context.mocks.s3.getSignedUrl.mockClear();
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockRejectedValueOnce(notFoundError());
    context.mocks.s3.send.mockResolvedValue({});

    const response = await prepareOk(body);

    expect(response.existing).toBeFalsy();
    expect(response.uploads?.archive.key).toContain(prepared.versionId);
    expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/storages/commit", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      commitClient().commit({ body: commitBody({}), headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid request bodies", async () => {
    await useClerkSession();

    const response = await accept(
      commitClient().commit({
        body: {
          storageType: "artifact",
          versionId: "0".repeat(64),
          files: [],
        } as never,
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("storageName");
  });

  it("returns 404 when storage does not exist", async () => {
    await useClerkSession();

    const response = await accept(
      commitClient().commit({
        body: commitBody({ storageName: storageName("missing") }),
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.message).toContain("not found");
  });

  it("returns 400 when the version id does not match the file hash", async () => {
    await useClerkSession();
    const body = prepareBody({ storageName: storageName("mismatch") });
    await prepareOk(body);

    const response = await accept(
      commitClient().commit({
        body: commitBody({
          storageName: body.storageName,
          storageType: body.storageType,
          versionId: "f".repeat(64),
          files: body.files,
        }),
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Version ID mismatch");
  });

  it("returns 400 when uploaded S3 objects are missing", async () => {
    await useClerkSession();
    const manifestBody = prepareBody({
      storageName: storageName("missing-manifest"),
    });
    const manifestPrepared = await prepareOk(manifestBody);

    context.mocks.s3.send.mockRejectedValueOnce(notFoundError());
    context.mocks.s3.send.mockResolvedValue({});
    const missingManifest = await accept(
      commitClient().commit({
        body: commitBody({
          storageName: manifestBody.storageName,
          storageType: manifestBody.storageType,
          versionId: manifestPrepared.versionId,
          files: manifestBody.files,
        }),
        headers: authHeaders(),
      }),
      [400],
    );
    expect(missingManifest.body.error.message).toContain("Manifest");

    context.mocks.s3.send.mockClear();
    const archiveBody = prepareBody({
      storageName: storageName("missing-archive"),
    });
    const archivePrepared = await prepareOk(archiveBody);
    context.mocks.s3.send.mockResolvedValueOnce({});
    context.mocks.s3.send.mockRejectedValueOnce(notFoundError());

    const missingArchive = await accept(
      commitClient().commit({
        body: commitBody({
          storageName: archiveBody.storageName,
          storageType: archiveBody.storageType,
          versionId: archivePrepared.versionId,
          files: archiveBody.files,
        }),
        headers: authHeaders(),
      }),
      [400],
    );

    expect(missingArchive.body.error.message).toContain("Archive");
  });

  it("creates a storage version and updates the head pointer", async () => {
    const auth = await useClerkSession();
    const body = prepareBody({ storageName: storageName("commit-success") });
    const prepared = await prepareOk(body);

    context.mocks.s3.send.mockResolvedValue({});
    const response = await commitOk(
      commitBody({
        storageName: body.storageName,
        storageType: body.storageType,
        versionId: prepared.versionId,
        files: body.files,
        message: "first version",
      }),
    );

    expect(response).toMatchObject({
      success: true,
      versionId: prepared.versionId,
      storageName: body.storageName,
      size: 100,
      fileCount: 1,
    });

    const db = store.set(writeDb$);
    const [storage] = await db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, auth.orgId),
          eq(storages.name, body.storageName),
        ),
      )
      .limit(1);
    expect(storage?.headVersionId).toBe(prepared.versionId);
    expect(storage?.size).toBe(100);
    expect(storage?.fileCount).toBe(1);
  });

  it("skips the archive requirement for empty artifacts", async () => {
    const auth = await useClerkSession();
    const body = prepareBody({
      storageName: storageName("empty-artifact"),
      files: [],
    });
    const prepared = await prepareOk(body);

    context.mocks.s3.send.mockResolvedValue({});
    const response = await commitOk(
      commitBody({
        storageName: body.storageName,
        storageType: body.storageType,
        versionId: prepared.versionId,
        files: [],
      }),
    );

    expect(response.fileCount).toBe(0);
    expect(response.size).toBe(0);
    expect(s3SendInputs()).toStrictEqual([
      {
        Bucket: BUCKET,
        Key: `${auth.orgId}/artifact/${body.storageName}/${prepared.versionId}/manifest.json`,
      },
    ]);
  });

  it("verifies uploaded S3 objects using org-id keys", async () => {
    const auth = await useClerkSession();
    const body = prepareBody({ storageName: storageName("s3-key-prefix") });
    const prepared = await prepareOk(body);

    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});
    await commitOk(
      commitBody({
        storageName: body.storageName,
        storageType: body.storageType,
        versionId: prepared.versionId,
        files: body.files,
      }),
    );

    expect(s3SendInputs()).toStrictEqual([
      {
        Bucket: BUCKET,
        Key: `${auth.orgId}/artifact/${body.storageName}/${prepared.versionId}/manifest.json`,
      },
      {
        Bucket: BUCKET,
        Key: `${auth.orgId}/artifact/${body.storageName}/${prepared.versionId}/archive.tar.gz`,
      },
    ]);
  });

  it("returns deduplicated=true when committing an existing version", async () => {
    await useClerkSession();
    const body = prepareBody({ storageName: storageName("dedupe") });
    const prepared = await prepareOk(body);
    const commit = commitBody({
      storageName: body.storageName,
      storageType: body.storageType,
      versionId: prepared.versionId,
      files: body.files,
    });

    context.mocks.s3.send.mockResolvedValue({});
    await commitOk(commit);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await commitOk(commit);

    expect(response.deduplicated).toBeTruthy();
    expect(response.versionId).toBe(prepared.versionId);
  });

  it("returns 409 when an existing version is missing S3 files", async () => {
    await useClerkSession();
    const body = prepareBody({ storageName: storageName("missing-existing") });
    const prepared = await prepareOk(body);
    const commit = commitBody({
      storageName: body.storageName,
      storageType: body.storageType,
      versionId: prepared.versionId,
      files: body.files,
    });

    context.mocks.s3.send.mockResolvedValue({});
    await commitOk(commit);

    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockRejectedValueOnce(notFoundError());
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      commitClient().commit({ body: commit, headers: authHeaders() }),
      [409],
    );

    expect(response.body.error).toStrictEqual({
      message: "S3 files missing for existing version - please retry upload",
      code: "S3_FILES_MISSING",
    });
  });
});
