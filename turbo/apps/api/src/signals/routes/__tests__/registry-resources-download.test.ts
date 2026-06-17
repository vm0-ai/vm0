import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const routeMocks = createZeroRouteMocks(context);

const STORAGE_NAME = "registry-resource@template:html-ppt-business-data";
const VERSION_ID =
  "5d981ea6d44248fdfffb7b467e40177a394f234d5f8ba9b3ff0c33e39d1c7081";
const ARCHIVE_SHA256 =
  "a5e0777b924534404a7be2e0a8b34feb546b70ec1f9b91058673e12c39772d86";

function client() {
  return setupApp({ context })(registryResourceDownloadContract);
}

function authHeaders() {
  routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  return { authorization: "Bearer clerk-session" };
}

function commandInput(command: unknown): Record<string, unknown> {
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

async function deleteStorageFixture(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(storages).where(eq(storages.name, STORAGE_NAME));
}

async function seedPrivateArchiveStorage(): Promise<string> {
  const writeDb = store.set(writeDb$);
  await deleteStorageFixture();

  const orgId = `org_${randomUUID()}`;
  const s3Prefix = `${orgId}/volume/${STORAGE_NAME}`;
  const s3Key = `${s3Prefix}/${VERSION_ID}`;
  const [storage] = await writeDb
    .insert(storages)
    .values({
      orgId,
      userId: VOLUME_ORG_USER_ID,
      name: STORAGE_NAME,
      type: "volume",
      s3Prefix,
      size: 1_433_248,
      fileCount: 19,
    })
    .returning({ id: storages.id });

  if (!storage) {
    throw new Error("Failed to seed registry resource storage");
  }

  await writeDb.insert(storageVersions).values({
    id: VERSION_ID,
    storageId: storage.id,
    s3Key,
    size: 1_433_248,
    fileCount: 19,
    message: "test private registry archive",
    createdBy: "test",
  });
  await writeDb
    .update(storages)
    .set({ headVersionId: VERSION_ID })
    .where(eq(storages.id, storage.id));

  return s3Key;
}

afterEach(async () => {
  await deleteStorageFixture();
});

describe("registry resource download", () => {
  it("returns a presigned URL for an allowlisted private registry archive", async () => {
    const s3Key = await seedPrivateArchiveStorage();
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "test-user-storages");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/private-resource.tar.gz?sig=test",
    );

    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:html-ppt-business-data" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: "template:html-ppt-business-data",
      type: "tar.gz",
      sha256: ARCHIVE_SHA256,
      versionId: VERSION_ID,
      fileCount: 19,
      size: 1_433_248,
      expiresInSeconds: 900,
      url: "https://r2.example.test/private-resource.tar.gz?sig=test",
    });

    const [, command] = context.mocks.s3.getSignedUrl.mock.calls.at(-1) ?? [];
    expect(commandInput(command)).toMatchObject({
      Bucket: "test-user-storages",
      Key: `${s3Key}/archive.tar.gz`,
    });
  });

  it("rejects registry resources that are not in the private archive allowlist", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:dashboard" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
