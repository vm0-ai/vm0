// Remnant legacy file, kept per api.bdd.md "Production-reachable but not
// API-constructible" (runners.test.ts / firewall-auth precedent): version ids
// are SHA-256 content hashes computed server-side, so two versions of one
// storage sharing an 8-hex-char prefix cannot be constructed deterministically
// through any API (birthday bound ~ 2^16 commits). The ambiguous-prefix 400
// (storage-read.service.ts:182-184) therefore stays covered by this DB-seeded
// case. Route-level storage coverage lives in storages.bdd.test.ts
// (FILE-01 STOR-01..04).
import { randomUUID } from "node:crypto";

import { storagesDownloadContract } from "@vm0/api-contracts/contracts/storages";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface VersionSeed {
  readonly id: string;
  readonly size: number;
  readonly fileCount: number;
}

interface SeedStorageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly versions: readonly VersionSeed[];
}

interface StorageFixture {
  readonly orgId: string;
}

function downloadClient() {
  return setupApp({ context })(storagesDownloadContract);
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

  if (storageIds.length > 0) {
    await db
      .delete(storageVersions)
      .where(inArray(storageVersions.storageId, storageIds));
  }

  await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
}

const trackStorage = createFixtureTracker<StorageFixture>(deleteStorageFixture);

async function seedStorage(args: SeedStorageArgs): Promise<StorageFixture> {
  const db = store.set(writeDb$);
  const storageId = randomUUID();

  await db.insert(storages).values({
    id: storageId,
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    type: "artifact",
    s3Prefix: `storages/${storageId}`,
  });

  for (const version of args.versions) {
    await db.insert(storageVersions).values({
      id: version.id,
      storageId,
      s3Key: `storages/${storageId}/${version.id}`,
      size: version.size,
      fileCount: version.fileCount,
      createdBy: args.userId,
    });
  }

  return { orgId: args.orgId };
}

describe("GET /api/storages/download", () => {
  it("returns 400 when a version prefix is ambiguous", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const prefix = "1234abcd";
    await trackStorage(
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
      query: { name: "ambiguous-prefix", type: "artifact", version: prefix },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      return;
    }
    expect(response.body.error.message).toContain("Ambiguous");
  });
});
