import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  insertTestStorage,
  insertTestExportJob,
} from "../../../../__tests__/api-test-helpers";
import { deleteUserS3Data } from "../user-s3-cleanup";

const context = testContext();

describe("deleteUserS3Data", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    orgId = user.orgId;
  });

  it("should complete without error when user has no data", async () => {
    await deleteUserS3Data(userId);

    expect(context.mocks.s3.listS3Objects).not.toHaveBeenCalled();
    expect(context.mocks.s3.deleteS3Objects).not.toHaveBeenCalled();
  });

  it("should delete S3 objects for user storages", async () => {
    const name1 = uniqueId("storage");
    const name2 = uniqueId("storage");

    await insertTestStorage({ userId, orgId, name: name1, type: "artifact" });
    await insertTestStorage({ userId, orgId, name: name2, type: "artifact" });

    const prefix1 = `storages/${orgId}/${name1}/`;
    const prefix2 = `storages/${orgId}/${name2}/`;

    context.mocks.s3.listS3Objects
      .mockResolvedValueOnce([
        { key: `${prefix1}v1/archive.tar.gz`, size: 1024 },
        { key: `${prefix1}v1/manifest.json`, size: 256 },
      ])
      .mockResolvedValueOnce([{ key: `${prefix2}v1/data.bin`, size: 2048 }]);

    await deleteUserS3Data(userId);

    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledTimes(2);
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledTimes(2);
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix1}v1/archive.tar.gz`, `${prefix1}v1/manifest.json`],
    );
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix2}v1/data.bin`],
    );
  });

  it("should delete export job ZIPs with s3Key", async () => {
    const key1 = `exports/${userId}/${uniqueId("job")}.zip`;
    const key2 = `exports/${userId}/${uniqueId("job")}.zip`;

    await insertTestExportJob(orgId, {
      userId,
      status: "completed",
      s3Key: key1,
    });
    await insertTestExportJob(orgId, {
      userId,
      status: "completed",
      s3Key: key2,
    });

    await deleteUserS3Data(userId);

    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [key1, key2],
    );
  });

  it("should skip export jobs with null s3Key", async () => {
    await insertTestExportJob(orgId, {
      userId,
      status: "pending",
    });
    await insertTestExportJob(orgId, {
      userId,
      status: "failed",
    });

    await deleteUserS3Data(userId);

    expect(context.mocks.s3.deleteS3Objects).not.toHaveBeenCalled();
  });

  it("should clean up both storages and export jobs", async () => {
    const storageName = uniqueId("storage");
    await insertTestStorage({
      userId,
      orgId,
      name: storageName,
      type: "artifact",
    });
    const prefix = `storages/${orgId}/${storageName}/`;

    const exportKey = `exports/${userId}/${uniqueId("job")}.zip`;
    await insertTestExportJob(orgId, {
      userId,
      status: "completed",
      s3Key: exportKey,
    });

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: `${prefix}v1/archive.tar.gz`, size: 512 },
    ]);

    await deleteUserS3Data(userId);

    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix}v1/archive.tar.gz`],
    );
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [exportKey],
    );
  });

  it("should not call deleteS3Objects when storage prefix has no objects", async () => {
    const storageName = uniqueId("storage");
    await insertTestStorage({
      userId,
      orgId,
      name: storageName,
      type: "artifact",
    });
    const prefix = `storages/${orgId}/${storageName}/`;

    // listS3Objects returns empty array (default mock behavior)

    await deleteUserS3Data(userId);

    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      prefix,
    );
    expect(context.mocks.s3.deleteS3Objects).not.toHaveBeenCalled();
  });

  it("continues cleanup when one storage fails (best-effort)", async () => {
    const name1 = uniqueId("storage");
    const name2 = uniqueId("storage");
    const exportKey = `exports/${userId}/${uniqueId("job")}.zip`;

    await insertTestStorage({ userId, orgId, name: name1, type: "artifact" });
    await insertTestStorage({ userId, orgId, name: name2, type: "artifact" });
    await insertTestExportJob(orgId, {
      userId,
      status: "completed",
      s3Key: exportKey,
    });

    const prefix2 = `storages/${orgId}/${name2}/`;

    // First storage listing throws an error
    context.mocks.s3.listS3Objects
      .mockRejectedValueOnce(new Error("S3 unavailable"))
      .mockResolvedValueOnce([{ key: `${prefix2}v1/data.bin`, size: 2048 }]);

    // Should complete without throwing despite first storage failure
    await deleteUserS3Data(userId);

    // Second storage should still be cleaned up
    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledTimes(2);
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix2}v1/data.bin`],
    );

    // Export jobs should still be cleaned up
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [exportKey],
    );
  });

  it("is idempotent - calling twice produces no errors", async () => {
    const storageName = uniqueId("storage");
    await insertTestStorage({
      userId,
      orgId,
      name: storageName,
      type: "artifact",
    });

    // First call: no objects found (default mock)
    await deleteUserS3Data(userId);
    // Second call: same result
    await deleteUserS3Data(userId);

    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledTimes(2);
  });
});
