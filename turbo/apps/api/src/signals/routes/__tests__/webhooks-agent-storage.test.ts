import { randomUUID } from "node:crypto";

import {
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { MAX_FILE_SIZE_BYTES } from "@vm0/api-contracts/contracts/storages";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { storageVersionLineage } from "@vm0/db/schema/storage-version-lineage";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
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

type StorageType = "volume" | "artifact";

interface StorageFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface AgentStorageFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

interface PrepareBody {
  readonly runId: string;
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly files: StorageFile[];
}

interface CommitBody {
  readonly runId: string;
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly versionId: string;
  readonly parentVersionId?: string;
  readonly files: StorageFile[];
  readonly message?: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    runId: fixture.runId,
    userId: fixture.userId,
    orgId: fixture.orgId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function authHeaders(fixture: AgentStorageFixture): {
  readonly authorization: string;
} {
  return { authorization: `Bearer ${sandboxToken(fixture)}` };
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

function prepareBody(
  fixture: AgentStorageFixture,
  overrides: Partial<PrepareBody> = {},
): PrepareBody {
  return {
    runId: fixture.runId,
    storageName: storageName("agent-storage"),
    storageType: "artifact",
    files: [validFile()],
    ...overrides,
  };
}

function commitBody(
  fixture: AgentStorageFixture,
  overrides: Partial<CommitBody>,
): CommitBody {
  return {
    runId: fixture.runId,
    storageName: storageName("agent-storage"),
    storageType: "artifact",
    versionId: "0".repeat(64),
    files: [validFile()],
    ...overrides,
  };
}

function prepareClient() {
  return setupApp({ context })(webhookStoragesPrepareContract);
}

function commitClient() {
  return setupApp({ context })(webhookStoragesCommitContract);
}

async function seedFixture(): Promise<AgentStorageFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: base.orgId, userId: base.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      status: "running",
    },
    context.signal,
  );
  return { ...base, composeId, runId };
}

async function prepareOk(fixture: AgentStorageFixture, body: PrepareBody) {
  const response = await accept(
    prepareClient().prepare({
      body,
      headers: authHeaders(fixture),
    }),
    [200],
  );
  return response.body;
}

async function storageLineage(versionId: string) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(storageVersionLineage)
    .where(eq(storageVersionLineage.versionId, versionId));
}

const track = createFixtureTracker<AgentStorageFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
});

describe("POST /api/webhooks/agent/storages/prepare", () => {
  it("rejects missing sandbox auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody(fixture),
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated or runId mismatch",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects a body runId that does not match the sandbox token", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody(fixture, { runId: randomUUID() }),
        headers: authHeaders(fixture),
      }),
      [401],
    );

    expect(response.body.error.message).toBe(
      "Not authenticated or runId mismatch",
    );
  });

  it("returns 404 when the sandbox run does not exist", async () => {
    const fixture = await track(seedFixture());
    const missingRunId = randomUUID();
    const missingRunFixture = { ...fixture, runId: missingRunId };

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody(fixture, { runId: missingRunId }),
        headers: {
          authorization: `Bearer ${sandboxToken(missingRunFixture)}`,
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("creates storage metadata scoped to the sandbox run organization", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-prepare");
    const body = prepareBody(fixture, { storageName: name });

    const response = await prepareOk(fixture, body);

    expect(response.existing).toBeFalsy();
    expect(response.uploads?.archive.key).toBe(
      `${fixture.orgId}/artifact/${name}/${response.versionId}/archive.tar.gz`,
    );
    expect(response.uploads?.manifest.key).toBe(
      `${fixture.orgId}/artifact/${name}/${response.versionId}/manifest.json`,
    );
    expect(response.uploads?.archive.presignedUrl).toMatch(/^https?:\/\//);
    expect(response.uploads?.manifest.presignedUrl).toMatch(/^https?:\/\//);

    const db = store.set(writeDb$);
    const [storage] = await db
      .select()
      .from(storages)
      .where(and(eq(storages.orgId, fixture.orgId), eq(storages.name, name)))
      .limit(1);
    expect(storage).toMatchObject({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name,
      type: "artifact",
      size: 0,
      fileCount: 0,
    });
  });

  it("rejects total declared file size over 100MB", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody(fixture, {
          files: [
            validFile({ path: "one.bin", size: MAX_FILE_SIZE_BYTES }),
            validFile({
              path: "two.bin",
              hash: SECOND_TEST_HASH,
              size: 1,
            }),
          ],
        }),
        headers: authHeaders(fixture),
      }),
      [413],
    );

    expect(response.body.error).toStrictEqual({
      message: "Upload rejected: total file size exceeds 100MB limit",
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("returns 400 when one file exceeds the per-file size schema limit", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareClient().prepare({
        body: prepareBody(fixture, {
          files: [
            validFile({
              path: "large-file.bin",
              size: MAX_FILE_SIZE_BYTES + 1,
            }),
          ],
        }),
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns existing=true for deduplicated versions with uploaded S3 files", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-prepare-existing");
    const body = prepareBody(fixture, { storageName: name });
    const prepared = await prepareOk(fixture, body);

    context.mocks.s3.send.mockResolvedValue({});
    await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: name,
          versionId: prepared.versionId,
          files: body.files,
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    context.mocks.s3.getSignedUrl.mockClear();
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await prepareOk(fixture, body);

    expect(response).toStrictEqual({
      versionId: prepared.versionId,
      existing: true,
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/agent/storages/commit", () => {
  it("rejects missing sandbox auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: storageName("missing-auth"),
        }),
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated or runId mismatch",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 404 when storage does not exist", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("missing-storage");

    const response = await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: name,
          storageType: "volume",
        }),
        headers: authHeaders(fixture),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Storage "${name}" not found`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 400 when versionId does not match prepared files", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-mismatch");
    const file = validFile({ path: "mismatch.txt" });
    const prepare = prepareBody(fixture, {
      storageName: name,
      storageType: "volume",
      files: [file],
    });
    await prepareOk(fixture, prepare);

    const response = await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: name,
          storageType: "volume",
          versionId: "f".repeat(64),
          files: [file],
        }),
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Version ID mismatch");
  });

  it("commits uploaded storage and records artifact lineage", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-commit");
    const parentVersionId = SECOND_TEST_HASH;
    const prepare = prepareBody(fixture, { storageName: name });
    const prepared = await prepareOk(fixture, prepare);

    context.mocks.s3.send.mockResolvedValue({});
    const response = await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: name,
          storageType: "artifact",
          versionId: prepared.versionId,
          parentVersionId,
          files: prepare.files,
          message: "agent commit",
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      success: true,
      versionId: prepared.versionId,
      storageName: name,
      size: 100,
      fileCount: 1,
    });

    const db = store.set(writeDb$);
    const [storage] = await db
      .select()
      .from(storages)
      .where(and(eq(storages.orgId, fixture.orgId), eq(storages.name, name)))
      .limit(1);
    expect(storage?.headVersionId).toBe(prepared.versionId);

    const [version] = await db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storage?.id ?? ""),
          eq(storageVersions.id, prepared.versionId),
        ),
      )
      .limit(1);
    expect(version).toMatchObject({
      id: prepared.versionId,
      size: 100,
      fileCount: 1,
      message: "agent commit",
      createdBy: "agent",
    });

    const [lineage] = await db
      .select()
      .from(storageVersionLineage)
      .where(eq(storageVersionLineage.versionId, prepared.versionId))
      .limit(1);
    expect(lineage).toMatchObject({
      storageId: storage?.id,
      versionId: prepared.versionId,
      parentVersionId,
      runId: fixture.runId,
      storageType: "artifact",
    });
  });

  it("returns deduplicated=true for idempotent re-commit", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-idempotent");
    const file = validFile({ path: "idempotent.txt" });
    const prepare = prepareBody(fixture, {
      storageName: name,
      storageType: "volume",
      files: [file],
    });
    const prepared = await prepareOk(fixture, prepare);
    const request = {
      body: commitBody(fixture, {
        storageName: name,
        storageType: "volume",
        versionId: prepared.versionId,
        files: [file],
      }),
      headers: authHeaders(fixture),
    };

    context.mocks.s3.send.mockResolvedValue({});
    await accept(commitClient().commit(request), [200]);

    const response = await accept(commitClient().commit(request), [200]);

    expect(response.body).toMatchObject({
      success: true,
      versionId: prepared.versionId,
      storageName: name,
      size: 100,
      fileCount: 1,
      deduplicated: true,
    });
  });

  it("does not record lineage when parentVersionId is absent", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-no-lineage");
    const file = validFile({ path: "no-lineage.txt" });
    const prepare = prepareBody(fixture, {
      storageName: name,
      files: [file],
    });
    const prepared = await prepareOk(fixture, prepare);

    context.mocks.s3.send.mockResolvedValue({});
    await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: name,
          versionId: prepared.versionId,
          files: [file],
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    await expect(storageLineage(prepared.versionId)).resolves.toStrictEqual([]);
  });

  it("does not record lineage for volume commits", async () => {
    const fixture = await track(seedFixture());
    const name = storageName("webhook-volume");
    const file = validFile({ path: "volume.txt" });
    const prepare = prepareBody(fixture, {
      storageName: name,
      storageType: "volume",
      files: [file],
    });
    const prepared = await prepareOk(fixture, prepare);

    context.mocks.s3.send.mockResolvedValue({});
    await accept(
      commitClient().commit({
        body: commitBody(fixture, {
          storageName: name,
          storageType: "volume",
          versionId: prepared.versionId,
          parentVersionId: SECOND_TEST_HASH,
          files: [file],
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    await expect(storageLineage(prepared.versionId)).resolves.toStrictEqual([]);
  });
});
