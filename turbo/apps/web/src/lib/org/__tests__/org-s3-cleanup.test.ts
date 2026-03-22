import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import {
  createTestVolumeForOrg,
  insertTestExportJob,
} from "../../../__tests__/api-test-helpers";
import { deleteOrgS3Data } from "../org-s3-cleanup";

const context = testContext();

describe("deleteOrgS3Data", () => {
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    orgId = user.orgId;
  });

  it("should complete without error when org has no data", async () => {
    await deleteOrgS3Data(orgId);

    expect(context.mocks.s3.listS3Objects).not.toHaveBeenCalled();
    expect(context.mocks.s3.deleteS3Objects).not.toHaveBeenCalled();
  });

  it("should delete S3 objects for storages", async () => {
    const name1 = uniqueId("vol");
    const name2 = uniqueId("vol");

    await createTestVolumeForOrg(orgId, name1);
    await createTestVolumeForOrg(orgId, name2);

    const prefix1 = `${orgId}/${name1}`;
    const prefix2 = `${orgId}/${name2}`;

    context.mocks.s3.listS3Objects
      .mockResolvedValueOnce([
        { key: `${prefix1}/v1/archive.tar.gz`, size: 1024 },
        { key: `${prefix1}/v1/manifest.json`, size: 256 },
      ])
      .mockResolvedValueOnce([
        { key: `${prefix2}/v1/archive.tar.gz`, size: 2048 },
      ]);

    await deleteOrgS3Data(orgId);

    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledTimes(2);
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledTimes(2);
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix1}/v1/archive.tar.gz`, `${prefix1}/v1/manifest.json`],
    );
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix2}/v1/archive.tar.gz`],
    );
  });

  it("should delete export job ZIPs with s3Key", async () => {
    const key1 = `exports/user1/${uniqueId("job")}.zip`;
    const key2 = `exports/user2/${uniqueId("job")}.zip`;

    await insertTestExportJob(orgId, {
      userId: uniqueId("user"),
      status: "completed",
      s3Key: key1,
    });
    await insertTestExportJob(orgId, {
      userId: uniqueId("user"),
      status: "completed",
      s3Key: key2,
    });

    await deleteOrgS3Data(orgId);

    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [key1, key2],
    );
  });

  it("should skip export jobs with null s3Key", async () => {
    await insertTestExportJob(orgId, {
      userId: uniqueId("user"),
      status: "pending",
    });
    await insertTestExportJob(orgId, {
      userId: uniqueId("user"),
      status: "failed",
    });

    await deleteOrgS3Data(orgId);

    expect(context.mocks.s3.deleteS3Objects).not.toHaveBeenCalled();
  });

  it("should clean up both storages and export jobs", async () => {
    const volName = uniqueId("vol");
    await createTestVolumeForOrg(orgId, volName);
    const prefix = `${orgId}/${volName}`;

    const exportKey = `exports/user/${uniqueId("job")}.zip`;
    await insertTestExportJob(orgId, {
      userId: uniqueId("user"),
      status: "completed",
      s3Key: exportKey,
    });

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: `${prefix}/v1/archive.tar.gz`, size: 512 },
    ]);

    await deleteOrgS3Data(orgId);

    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${prefix}/v1/archive.tar.gz`],
    );
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [exportKey],
    );
  });

  it("should not call deleteS3Objects when storage prefix has no objects", async () => {
    const volName = uniqueId("vol");
    await createTestVolumeForOrg(orgId, volName);
    const prefix = `${orgId}/${volName}`;

    // listS3Objects returns empty array (default mock behavior)

    await deleteOrgS3Data(orgId);

    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      prefix,
    );
    expect(context.mocks.s3.deleteS3Objects).not.toHaveBeenCalled();
  });
});
