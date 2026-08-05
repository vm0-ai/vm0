import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListObjectsV2Command,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
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
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [] });
      }
      if (command instanceof CreateMultipartUploadCommand) {
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
    expect(response.body.url).toMatch(
      /^https:\/\/cdn\.vm7\.io\/artifacts\/[0-9a-z]{10}\.mp4$/u,
    );
    const createCommand = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .find((command): command is CreateMultipartUploadCommand => {
        return command instanceof CreateMultipartUploadCommand;
      });
    expect(createCommand?.input).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: expect.stringMatching(/^artifacts\/[0-9a-z]{10}\.mp4$/u),
      ContentType: "video/mp4",
      Metadata: {
        "artifact-id": response.body.id,
        filename: "recording.mp4",
        "user-id": encodeURIComponent(userId),
      },
    });
  });

  it("keeps the legacy single PUT response for small multipart requests", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    mocks.s3.listObjects([]);

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
      url: expect.stringMatching(
        /^https:\/\/cdn\.vm7\.io\/artifacts\/[0-9a-z]{10}\.mp4$/u,
      ),
      uploadHeaders: {
        "x-amz-meta-artifact-id": response.body.id,
        "x-amz-meta-filename": "small.mp4",
        "x-amz-meta-user-id": encodeURIComponent(userId),
      },
    });
    expect(response.body).not.toHaveProperty("multipart");
  });

  it("aborts the multipart session when the API owner is cancelled after creation", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const controller = new AbortController();
    const abortError = new Error("API owner cancelled multipart preparation");
    abortError.name = "AbortError";
    const ownerContext = {
      mocks: context.mocks,
      sessionHistoryBlobs: context.sessionHistoryBlobs,
      signal: controller.signal,
    };
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [] });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        controller.abort(abortError);
        return Promise.resolve({ UploadId: "multipart-upload-cancelled" });
      }
      return Promise.resolve({});
    });

    const response = await setupApp({ context: ownerContext })(
      zeroUploadsContract,
    ).prepare({
      body: {
        filename: "cancelled.mp4",
        contentType: "video/mp4",
        size: 5 * 1024 * 1024,
        multipart: true,
      },
      headers: authHeaders(),
    });

    expect(response.status).toBe(500);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(3);
    const abortCommand = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .find((command): command is AbortMultipartUploadCommand => {
        return command instanceof AbortMultipartUploadCommand;
      });
    expect(abortCommand?.input).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: expect.stringMatching(/^artifacts\/[0-9a-z]{10}\.mp4$/u),
      UploadId: "multipart-upload-cancelled",
    });
  });

  it("lists uploaded parts and completes the multipart upload", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListPartsCommand) {
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
      url: expect.stringMatching(
        /^https:\/\/cdn\.vm7\.io\/artifacts\/[0-9a-z]{10}\.mp4$/u,
      ),
    });
    const completeCommand = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .find((command): command is CompleteMultipartUploadCommand => {
        return command instanceof CompleteMultipartUploadCommand;
      });
    expect(completeCommand?.input).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: expect.stringMatching(/^artifacts\/[0-9a-z]{10}\.mp4$/u),
      UploadId: "multipart-upload-1",
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
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
    const abortCommand = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .find((command): command is AbortMultipartUploadCommand => {
        return command instanceof AbortMultipartUploadCommand;
      });
    expect(abortCommand?.input).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: expect.stringMatching(/^artifacts\/[0-9a-z]{10}\.mp4$/u),
      UploadId: "multipart-upload-3",
    });
  });
});
