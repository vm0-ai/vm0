import { cronStorageArchiveSizeBackfillContract } from "@vm0/api-contracts/contracts/cron";
import {
  testStorageArchiveSizeBackfillStateContract,
  type TestStorageArchiveSizeBackfillVersionSeed,
} from "@vm0/api-contracts/contracts/test-storage-archive-size-backfill-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { cronStorageArchiveSizeBackfillRoutes } from "../cron-backfill-storage-archive-sizes";
import { testStorageArchiveSizeBackfillStateRoutes } from "../test-storage-archive-size-backfill-state";

const context = testContext();
const CRON_SECRET = "test-storage-archive-size-backfill-secret";
const BUCKET = "test-user-storages";
const ROUTES = [
  ...cronStorageArchiveSizeBackfillRoutes,
  ...testStorageArchiveSizeBackfillStateRoutes,
] as const;
const TEST_PREFIX = `archive-backfill-${process.pid}`;

function cronClient() {
  return setupApp({ context, routes: ROUTES })(
    cronStorageArchiveSizeBackfillContract,
  );
}

function stateClient() {
  return setupApp({ context, routes: ROUTES })(
    testStorageArchiveSizeBackfillStateContract,
  );
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function versionSeed(
  index: number,
  overrides: Partial<
    Pick<
      TestStorageArchiveSizeBackfillVersionSeed,
      "file_count" | "archive_size"
    >
  > = {},
): TestStorageArchiveSizeBackfillVersionSeed {
  const orderedIndex = index.toString().padStart(4, "0");
  return {
    id: `!${TEST_PREFIX}-${orderedIndex}`,
    storage_name: `${TEST_PREFIX}-${orderedIndex}`,
    s3_key: `${TEST_PREFIX}/${orderedIndex}`,
    file_count: overrides.file_count ?? 1,
    archive_size: overrides.archive_size ?? null,
  };
}

async function seedVersions(
  versions: readonly TestStorageArchiveSizeBackfillVersionSeed[],
): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "seed", versions: [...versions] },
    }),
    [200],
  );
}

async function cleanupState(): Promise<void> {
  await accept(
    stateClient().action({
      body: {
        action: "cleanup",
        storage_name_prefix: TEST_PREFIX,
      },
    }),
    [200],
  );
}

async function readVersions(versionIds: readonly string[]) {
  const response = await accept(
    stateClient().action({
      body: { action: "read", version_ids: [...versionIds] },
    }),
    [200],
  );
  return response.body.versions ?? [];
}

async function runBackfill() {
  const response = await accept(
    cronClient().backfill({ headers: cronHeaders() }),
    [200],
  );
  if (response.body.state !== "active") {
    throw new Error("Backfill tables unexpectedly retired");
  }
  return response.body;
}

async function readStatus() {
  const response = await accept(
    cronClient().status({ headers: cronHeaders() }),
    [200],
  );
  if (response.body.state !== "active") {
    throw new Error("Backfill tables unexpectedly retired");
  }
  return response.body;
}

function headInput(command: unknown): {
  readonly Bucket: string;
  readonly Key: string;
} {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command)
  ) {
    throw new Error("Expected an S3 HeadObject command");
  }
  const input = command.input;
  if (
    typeof input !== "object" ||
    input === null ||
    !("Bucket" in input) ||
    typeof input.Bucket !== "string" ||
    !("Key" in input) ||
    typeof input.Key !== "string"
  ) {
    throw new Error("Expected a bucket and key in S3 HeadObject input");
  }
  return { Bucket: input.Bucket, Key: input.Key };
}

function notFoundError(): Error {
  const error = new Error("Object not found");
  error.name = "NotFound";
  return error;
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockReset();
  context.mocks.s3.send.mockResolvedValue({ ContentLength: 64 });
});

afterEach(async () => {
  await accept(
    stateClient().action({
      body: { action: "restore-temporary-tables" },
    }),
    [200],
  );
  await cleanupState();
});

describe("storage archive size backfill cron", () => {
  it("authenticates both operations before reading temporary state", async () => {
    const backfillResponse = await accept(
      cronClient().backfill({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    const statusResponse = await accept(
      cronClient().status({ headers: {} }),
      [401],
    );

    expect(backfillResponse.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
    expect(statusResponse.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("records exact outcomes, retries unresolved work, and reconciles status", async () => {
    const versions = [
      versionSeed(0),
      versionSeed(1, { file_count: 0 }),
      versionSeed(2),
      versionSeed(3),
      versionSeed(4),
      versionSeed(5),
      versionSeed(6),
      versionSeed(7, { archive_size: -1 }),
      versionSeed(8, { archive_size: 0 }),
    ] as const;
    const firstPassPadding = Array.from({ length: 18 }, (_, index) => {
      return versionSeed(index + 9);
    });
    await seedVersions([...versions, ...firstPassPadding]);

    const firstPassByKey = new Map<string, () => Promise<unknown>>([
      [
        `${versions[0].s3_key}/archive.tar.gz`,
        () => {
          return Promise.resolve({ ContentLength: 321 });
        },
      ],
      [
        `${versions[1].s3_key}/archive.tar.gz`,
        () => {
          return Promise.reject(notFoundError());
        },
      ],
      [
        `${versions[2].s3_key}/archive.tar.gz`,
        () => {
          return Promise.reject(notFoundError());
        },
      ],
      [
        `${versions[3].s3_key}/archive.tar.gz`,
        () => {
          return Promise.resolve({});
        },
      ],
      [
        `${versions[4].s3_key}/archive.tar.gz`,
        () => {
          return Promise.resolve({ ContentLength: 0 });
        },
      ],
      [
        `${versions[5].s3_key}/archive.tar.gz`,
        () => {
          return Promise.resolve({
            ContentLength: Number.MAX_SAFE_INTEGER + 1,
          });
        },
      ],
      [
        `${versions[6].s3_key}/archive.tar.gz`,
        () => {
          return Promise.reject(new Error("provider detail must not persist"));
        },
      ],
    ]);
    context.mocks.s3.send.mockImplementation((command) => {
      const input = headInput(command);
      expect(input.Bucket).toBe(BUCKET);
      const response = firstPassByKey.get(input.Key);
      if (response) {
        return response();
      }
      if (!input.Key.startsWith(`${TEST_PREFIX}/`)) {
        return Promise.reject(new Error(`Unexpected HEAD ${input.Key}`));
      }
      return Promise.resolve({ ContentLength: 128 });
    });

    const firstPass = await runBackfill();

    expect(firstPass).toMatchObject({
      selected: 25,
      positive: 19,
      intentionalEmpty: 1,
      alreadyCompleted: 0,
      superseded: 0,
      missing: 1,
      invalid: 3,
      failed: 1,
    });

    const firstRows = await readVersions(
      versions.map((version) => {
        return version.id;
      }),
    );
    expect(firstRows).toStrictEqual([
      expect.objectContaining({
        id: versions[0].id,
        archive_size: 321,
        work: null,
      }),
      expect.objectContaining({
        id: versions[1].id,
        archive_size: 0,
        work: null,
      }),
      expect.objectContaining({
        id: versions[2].id,
        archive_size: null,
        work: expect.objectContaining({
          attempt_count: 1,
          outcome: "missing",
          error_code: "archive-not-found",
        }),
      }),
      expect.objectContaining({
        id: versions[3].id,
        archive_size: null,
        work: expect.objectContaining({
          outcome: "invalid",
          error_code: "content-length-missing",
        }),
      }),
      expect.objectContaining({
        id: versions[4].id,
        archive_size: null,
        work: expect.objectContaining({
          outcome: "invalid",
          error_code: "content-length-non-positive",
        }),
      }),
      expect.objectContaining({
        id: versions[5].id,
        archive_size: null,
        work: expect.objectContaining({
          outcome: "invalid",
          error_code: "content-length-unsafe",
        }),
      }),
      expect.objectContaining({
        id: versions[6].id,
        archive_size: null,
        work: expect.objectContaining({
          outcome: "failed",
          error_code: "head-request-failed",
        }),
      }),
      expect.objectContaining({ id: versions[7].id, archive_size: -1 }),
      expect.objectContaining({ id: versions[8].id, archive_size: 0 }),
    ]);

    const unresolvedStatus = await readStatus();
    expect(unresolvedStatus).toMatchObject({
      unresolved: { missing: 1, invalid: 3, failed: 1 },
      complete: false,
    });
    expect(unresolvedStatus.totalVersions).toBeGreaterThanOrEqual(27);
    expect(unresolvedStatus.positiveArchives).toBeGreaterThanOrEqual(19);
    expect(unresolvedStatus.intentionalEmptyArchives).toBeGreaterThanOrEqual(1);
    expect(unresolvedStatus.remaining).toBeGreaterThanOrEqual(5);
    expect(unresolvedStatus.negativeArchives).toBeGreaterThanOrEqual(1);
    expect(unresolvedStatus.nonEmptyZeroArchives).toBeGreaterThanOrEqual(1);
    expect(unresolvedStatus.unattemptedOrInFlight).toBe(
      unresolvedStatus.remaining - 5,
    );

    context.mocks.s3.send.mockImplementation((command) => {
      const input = headInput(command);
      expect(input.Bucket).toBe(BUCKET);
      return Promise.resolve({ ContentLength: 512 });
    });

    const retryPadding = Array.from({ length: 20 }, (_, index) => {
      return versionSeed(index + 27);
    });
    await seedVersions(retryPadding);
    const retry = await runBackfill();
    expect(retry).toMatchObject({
      selected: 25,
      positive: 25,
      intentionalEmpty: 0,
      alreadyCompleted: 0,
      superseded: 0,
      missing: 0,
      invalid: 0,
      failed: 0,
    });

    const finalStatus = await readStatus();
    expect(finalStatus).toMatchObject({
      unresolved: { missing: 0, invalid: 0, failed: 0 },
      complete: false,
    });
    expect(finalStatus.totalVersions).toBeGreaterThanOrEqual(47);
    expect(finalStatus.positiveArchives).toBeGreaterThanOrEqual(44);
    expect(finalStatus.intentionalEmptyArchives).toBeGreaterThanOrEqual(1);
    expect(finalStatus.negativeArchives).toBeGreaterThanOrEqual(1);
    expect(finalStatus.nonEmptyZeroArchives).toBeGreaterThanOrEqual(1);
    expect(finalStatus.unattemptedOrInFlight).toBe(finalStatus.remaining);
  });

  it("limits a batch to 25 versions and four concurrent HEAD requests", async () => {
    const versions = Array.from({ length: 30 }, (_, index) => {
      return versionSeed(index);
    });
    await seedVersions(versions);

    const fourStarted = createDeferredPromise<void>(context.signal);
    const releaseHeads = createDeferredPromise<void>(context.signal);
    let activeHeads = 0;
    let maxActiveHeads = 0;
    context.mocks.s3.send.mockImplementation(async (command) => {
      headInput(command);
      activeHeads += 1;
      maxActiveHeads = Math.max(maxActiveHeads, activeHeads);
      if (activeHeads === 4 && !fourStarted.settled()) {
        fourStarted.resolve();
      }
      await releaseHeads.promise;
      activeHeads -= 1;
      return { ContentLength: 128 };
    });

    const request = runBackfill();
    await fourStarted.promise;
    const startedRequestCount = context.mocks.s3.send.mock.calls.length;
    releaseHeads.resolve();
    const result = await request;
    expect(startedRequestCount).toBe(4);
    expect(result).toMatchObject({ selected: 25, positive: 25 });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(25);
    expect(maxActiveHeads).toBe(4);
  });

  it("reserves disjoint claims for overlapping invocations", async () => {
    const versions = Array.from({ length: 50 }, (_, index) => {
      return versionSeed(index);
    });
    await seedVersions(versions);

    const eightStarted = createDeferredPromise<void>(context.signal);
    const releaseHeads = createDeferredPromise<void>(context.signal);
    const requestedKeys: string[] = [];
    let activeHeads = 0;
    const firstFourStarted = createDeferredPromise<void>(context.signal);
    const observeFirstFour = () => {
      if (
        context.mocks.s3.send.mock.calls.length >= 4 &&
        !firstFourStarted.settled()
      ) {
        firstFourStarted.resolve();
      }
    };
    context.mocks.s3.send.mockImplementation(async (command) => {
      const input = headInput(command);
      requestedKeys.push(input.Key);
      activeHeads += 1;
      observeFirstFour();
      if (activeHeads === 8 && !eightStarted.settled()) {
        eightStarted.resolve();
      }
      await releaseHeads.promise;
      activeHeads -= 1;
      return { ContentLength: 256 };
    });

    const firstRequest = runBackfill();
    await firstFourStarted.promise;
    const secondRequest = runBackfill();
    await eightStarted.promise;
    releaseHeads.resolve();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first.selected).toBe(25);
    expect(second.selected).toBe(25);
    expect(requestedKeys).toHaveLength(50);
    expect(new Set(requestedKeys).size).toBe(50);
  });

  it("processes untouched rows before retrying a permanent low-id failure", async () => {
    const failedSeed = versionSeed(0);
    const versions = [
      failedSeed,
      ...Array.from({ length: 49 }, (_, index) => {
        return versionSeed(index + 1);
      }),
    ];
    const failedKey = `${failedSeed.s3_key}/archive.tar.gz`;
    await seedVersions(versions);

    const requestedKeys: string[] = [];
    context.mocks.s3.send.mockImplementation((command) => {
      const input = headInput(command);
      requestedKeys.push(input.Key);
      return input.Key === failedKey
        ? Promise.reject(notFoundError())
        : Promise.resolve({ ContentLength: 64 });
    });

    const first = await runBackfill();
    const second = await runBackfill();

    expect(first).toMatchObject({ selected: 25, positive: 24, missing: 1 });
    expect(second).toMatchObject({ selected: 25, positive: 25, missing: 0 });
    expect(
      requestedKeys.filter((key) => {
        return key === failedKey;
      }),
    ).toHaveLength(1);

    const [failedVersion] = await readVersions([failedSeed.id]);
    expect(failedVersion?.work).toMatchObject({
      attempt_count: 1,
      outcome: "missing",
      error_code: "archive-not-found",
    });
  });

  it("preserves a concurrently completed archive and removes its owned claim", async () => {
    const version = versionSeed(0);
    const padding = Array.from({ length: 24 }, (_, index) => {
      return versionSeed(index + 1);
    });
    await seedVersions([version, ...padding]);

    const headStarted = createDeferredPromise<void>(context.signal);
    const releaseHead = createDeferredPromise<void>(context.signal);
    context.mocks.s3.send.mockImplementation(async (command) => {
      const input = headInput(command);
      if (input.Key === `${version.s3_key}/archive.tar.gz`) {
        headStarted.resolve();
        await releaseHead.promise;
      }
      return { ContentLength: 111 };
    });

    const request = runBackfill();
    await headStarted.promise;
    await accept(
      stateClient().action({
        body: {
          action: "set-archive-size",
          version_id: version.id,
          archive_size: 999,
        },
      }),
      [200],
    );
    releaseHead.resolve();

    await expect(request).resolves.toMatchObject({
      selected: 25,
      positive: 24,
      alreadyCompleted: 1,
      superseded: 0,
    });
    const [completed] = await readVersions([version.id]);
    expect(completed).toMatchObject({ archive_size: 999, work: null });
  });

  it("recovers an expired claim and fences its late owner", async () => {
    const version = versionSeed(0);
    const firstPassPadding = Array.from({ length: 24 }, (_, index) => {
      return versionSeed(index + 1);
    });
    await seedVersions([version, ...firstPassPadding]);

    const firstHeadStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstHead = createDeferredPromise<void>(context.signal);
    const secondHeadStarted = createDeferredPromise<void>(context.signal);
    const releaseSecondHead = createDeferredPromise<void>(context.signal);
    const targetKey = `${version.s3_key}/archive.tar.gz`;
    let targetRequestCount = 0;
    context.mocks.s3.send.mockImplementation(async (command) => {
      const input = headInput(command);
      if (input.Key !== targetKey) {
        return { ContentLength: 64 };
      }
      targetRequestCount += 1;
      if (targetRequestCount === 1) {
        firstHeadStarted.resolve();
        await releaseFirstHead.promise;
        return { ContentLength: 111 };
      }
      secondHeadStarted.resolve();
      await releaseSecondHead.promise;
      return { ContentLength: 222 };
    });

    const firstRequest = runBackfill();
    await firstHeadStarted.promise;
    const [firstClaim] = await readVersions([version.id]);
    expect(firstClaim?.work).toMatchObject({
      attempt_count: 1,
      outcome: null,
      error_code: null,
    });

    await accept(
      stateClient().action({
        body: { action: "expire-claims", version_ids: [version.id] },
      }),
      [200],
    );
    const retryPadding = Array.from({ length: 24 }, (_, index) => {
      return versionSeed(index + 25);
    });
    await seedVersions(retryPadding);
    const secondRequest = runBackfill();
    await secondHeadStarted.promise;

    releaseFirstHead.resolve();
    const first = await firstRequest;
    expect(first).toMatchObject({
      selected: 25,
      positive: 24,
      superseded: 1,
    });

    const [superseded] = await readVersions([version.id]);
    expect(superseded).toMatchObject({
      archive_size: null,
      work: expect.objectContaining({
        attempt_count: 2,
        outcome: null,
        error_code: null,
      }),
    });

    releaseSecondHead.resolve();
    const second = await secondRequest;
    expect(second).toMatchObject({ selected: 25, positive: 25 });

    const [completed] = await readVersions([version.id]);
    expect(completed).toMatchObject({ archive_size: 222, work: null });
  });

  it("returns retired only for authenticated handlers after cleanup drops temporary tables", async () => {
    await accept(
      stateClient().action({
        body: { action: "retire-temporary-tables" },
      }),
      [200],
    );

    const unauthorizedBackfill = await accept(
      cronClient().backfill({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    const unauthorizedStatus = await accept(
      cronClient().status({ headers: {} }),
      [401],
    );
    const backfill = await accept(
      cronClient().backfill({ headers: cronHeaders() }),
      [200],
    );
    const status = await accept(
      cronClient().status({ headers: cronHeaders() }),
      [200],
    );

    expect(unauthorizedBackfill.status).toBe(401);
    expect(unauthorizedStatus.status).toBe(401);
    expect(backfill.body).toStrictEqual({ state: "retired" });
    expect(status.body).toStrictEqual({ state: "retired" });

    await accept(
      stateClient().action({
        body: { action: "restore-temporary-tables" },
      }),
      [200],
    );
    expect((await readStatus()).state).toBe("active");
  });

  it("rolls back a completed HEAD when cleanup drops tables during R2 work", async () => {
    const version = versionSeed(0);
    const padding = Array.from({ length: 24 }, (_, index) => {
      return versionSeed(index + 1);
    });
    await seedVersions([version, ...padding]);

    const headStarted = createDeferredPromise<void>(context.signal);
    const releaseHead = createDeferredPromise<void>(context.signal);
    context.mocks.s3.send.mockImplementation(async (command) => {
      const input = headInput(command);
      if (input.Key === `${version.s3_key}/archive.tar.gz`) {
        headStarted.resolve();
        await releaseHead.promise;
      }
      return { ContentLength: 444 };
    });

    const request = accept(
      cronClient().backfill({ headers: cronHeaders() }),
      [200],
    );
    await headStarted.promise;
    await accept(
      stateClient().action({
        body: { action: "retire-temporary-tables" },
      }),
      [200],
    );

    releaseHead.resolve();
    expect((await request).body).toStrictEqual({ state: "retired" });
    await accept(
      stateClient().action({
        body: { action: "restore-temporary-tables" },
      }),
      [200],
    );
    const [row] = await readVersions([version.id]);
    expect(row).toMatchObject({
      archive_size: null,
      work: expect.objectContaining({
        attempt_count: 1,
        outcome: null,
        error_code: null,
      }),
    });
  });
});
