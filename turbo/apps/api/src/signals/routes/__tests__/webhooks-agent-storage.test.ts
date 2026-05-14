import { randomUUID } from "node:crypto";

import {
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "@vm0/api-contracts/contracts/webhooks";
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
});

describe("POST /api/webhooks/agent/storages/commit", () => {
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

    const db = store.set(writeDb$);
    const lineage = await db
      .select()
      .from(storageVersionLineage)
      .where(eq(storageVersionLineage.versionId, prepared.versionId));
    expect(lineage).toStrictEqual([]);
  });
});
