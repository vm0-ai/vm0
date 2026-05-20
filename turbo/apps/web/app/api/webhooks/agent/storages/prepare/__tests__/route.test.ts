import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestStorageByName,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { commitPreparedTestStorage } from "../../../../../../../src/__tests__/db-test-seeders/storage";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";

import { randomUUID } from "crypto";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

function makePrepareRequest(
  runId: string,
  token: string | null,
  body: Record<string, unknown>,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return createTestRequest(
    "http://localhost:3000/api/webhooks/agent/storages/prepare",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ runId, ...body }),
    },
  );
}

describe("POST /api/webhooks/agent/storages/prepare", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("storage-prep"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
    testToken = await createTestSandboxToken(user.userId, testRunId);
  });

  it("should return 401 without authentication", async () => {
    const request = makePrepareRequest(testRunId, null, {
      storageName: "test",
      storageType: "volume",
      files: [],
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for non-existent run", async () => {
    const nonExistentRunId = randomUUID();
    const tokenForNonExistent = await createTestSandboxToken(
      user.userId,
      nonExistentRunId,
    );

    const request = makePrepareRequest(nonExistentRunId, tokenForNonExistent, {
      storageName: "test",
      storageType: "volume",
      files: [],
    });

    const response = await POST(request);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("should create new storage and return upload URLs", async () => {
    const storageName = uniqueId("webhook-new");
    const files = [{ path: "test.txt", hash: "a".repeat(64), size: 100 }];

    const request = makePrepareRequest(testRunId, testToken, {
      storageName,
      storageType: "volume",
      files,
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.versionId).toHaveLength(64);
    expect(json.existing).toBe(false);
    expect(json.uploads.archive.presignedUrl).toBe(
      "https://mock-presigned-put-url",
    );
    expect(json.uploads.manifest.presignedUrl).toBe(
      "https://mock-presigned-put-url",
    );
  });

  it("should return 413 when total file size exceeds 100MB", async () => {
    const storageName = uniqueId("webhook-oversize");

    const request = makePrepareRequest(testRunId, testToken, {
      storageName,
      storageType: "volume",
      files: [
        { path: "file1.bin", hash: "a".repeat(64), size: 60_000_000 },
        { path: "file2.bin", hash: "b".repeat(64), size: 60_000_000 },
      ],
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(json.error.message).toContain("100MB");
  });

  it("should reject single file exceeding 100MB via schema validation", async () => {
    const storageName = uniqueId("webhook-single-oversize");

    const request = makePrepareRequest(testRunId, testToken, {
      storageName,
      storageType: "volume",
      files: [{ path: "huge.bin", hash: "f".repeat(64), size: 104_857_601 }],
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should return existing=true for deduplicated version", async () => {
    const storageName = uniqueId("webhook-dedup");
    const files = [{ path: "test.txt", hash: "b".repeat(64), size: 100 }];

    // Prepare → get versionId
    const prepareResponse = await POST(
      makePrepareRequest(testRunId, testToken, {
        storageName,
        storageType: "volume",
        files,
      }),
    );
    const { versionId } = await prepareResponse.json();

    // Commit metadata directly because the commit webhook is API-authoritative.
    const storage = await findTestStorageByName(user.orgId, storageName);
    expect(storage).toBeDefined();
    if (!storage) {
      throw new Error("Expected prepared storage to exist");
    }
    await commitPreparedTestStorage({
      storageId: storage.id,
      versionId,
      files,
    });

    // Prepare again with same files → should be deduplicated
    const response = await POST(
      makePrepareRequest(testRunId, testToken, {
        storageName,
        storageType: "volume",
        files,
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.existing).toBe(true);
    expect(json).not.toHaveProperty("uploads");
  });
});
