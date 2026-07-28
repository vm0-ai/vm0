import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroUploadsContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("multipart user artifact uploads", () => {
  it("prepares 5 MiB parts for a large upload", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command?.constructor.name === "CreateMultipartUploadCommand") {
        return Promise.resolve({ UploadId: "multipart-upload-1" });
      }
      return Promise.resolve({});
    });
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        if (
          typeof command === "object" &&
          command !== null &&
          "input" in command &&
          typeof command.input === "object" &&
          command.input !== null &&
          "PartNumber" in command.input
        ) {
          return Promise.resolve(
            `https://r2.example.com/part-${String(command.input.PartNumber)}`,
          );
        }
        return Promise.resolve("https://r2.example.com/upload");
      },
    );

    const response = await accept(
      apiClient().prepare({
        body: {
          filename: "recording.mp4",
          contentType: "video/mp4",
          size: 20 * 1024 * 1024,
          multipart: true,
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "recording.mp4",
      contentType: "video/mp4",
      size: 20 * 1024 * 1024,
      multipart: {
        uploadId: "multipart-upload-1",
        partSize: 5 * 1024 * 1024,
        parts: [
          { partNumber: 1, uploadUrl: "https://r2.example.com/part-1" },
          { partNumber: 2, uploadUrl: "https://r2.example.com/part-2" },
          { partNumber: 3, uploadUrl: "https://r2.example.com/part-3" },
          { partNumber: 4, uploadUrl: "https://r2.example.com/part-4" },
        ],
      },
    });
    expect(context.mocks.s3.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: "test-user-artifacts",
        ContentType: "video/mp4",
      },
    });
  });

  it("keeps the legacy single PUT response for small multipart requests", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      apiClient().prepare({
        body: {
          filename: "small.mp4",
          contentType: "video/mp4",
          size: 5 * 1024 * 1024 - 1,
          multipart: true,
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      uploadUrl: "https://r2.example.com/upload?sig=test",
    });
    expect(response.body).not.toHaveProperty("multipart");
  });

  it("lists uploaded parts and completes the multipart upload", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command?.constructor.name === "ListPartsCommand") {
        return Promise.resolve({
          Parts: [
            { PartNumber: 1, ETag: '"etag-1"' },
            { PartNumber: 2, ETag: '"etag-2"' },
          ],
        });
      }
      return Promise.resolve({});
    });

    const response = await accept(
      apiClient().completeMultipart({
        body: {
          id: "3a513aef-a376-49c4-8f15-61f7e8e40526",
          filename: "my recording.mp4",
          uploadId: "multipart-upload-1",
          partCount: 2,
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: "3a513aef-a376-49c4-8f15-61f7e8e40526",
      url: `https://cdn.vm7.io/artifacts/${userId}/3a513aef-a376-49c4-8f15-61f7e8e40526/my_recording.mp4`,
    });
    expect(context.mocks.s3.send.mock.calls[1]?.[0]).toMatchObject({
      input: {
        Bucket: "test-user-artifacts",
        UploadId: "multipart-upload-1",
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: '"etag-1"' },
            { PartNumber: 2, ETag: '"etag-2"' },
          ],
        },
      },
    });
  });

  it("rejects completion when an uploaded part is missing", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({
      Parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
    });

    const response = await accept(
      apiClient().completeMultipart({
        body: {
          id: "857873df-23b7-47e8-8273-4bf9014b5dbe",
          filename: "recording.mp4",
          uploadId: "multipart-upload-2",
          partCount: 2,
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toBe("Multipart upload is incomplete");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(1);
  });

  it("aborts an unfinished multipart upload", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      apiClient().abortMultipart({
        body: {
          id: "ba428dc9-af58-4785-b45f-bbed9633ecde",
          filename: "my recording.mp4",
          uploadId: "multipart-upload-3",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: "ba428dc9-af58-4785-b45f-bbed9633ecde",
    });
    expect(context.mocks.s3.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: "test-user-artifacts",
        Key: `artifacts/${userId}/ba428dc9-af58-4785-b45f-bbed9633ecde/my_recording.mp4`,
        UploadId: "multipart-upload-3",
      },
    });
  });
});
