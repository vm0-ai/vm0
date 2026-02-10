import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { POST as preparePOST } from "../../prepare/route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

function makeCommitRequest(
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
    "http://localhost:3000/api/webhooks/agent/storages/commit",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ runId, ...body }),
    },
  );
}

/** Prepare a storage via webhook route and return the versionId */
async function prepareStorage(
  runId: string,
  token: string,
  storageName: string,
  storageType: string,
  files: Array<{ path: string; hash: string; size: number }>,
): Promise<string> {
  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/agent/storages/prepare",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ runId, storageName, storageType, files }),
    },
  );
  const response = await preparePOST(request);
  const data = await response.json();
  return data.versionId;
}

describe("POST /api/webhooks/agent/storages/commit", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("storage-commit"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
    testToken = await createTestSandboxToken(user.userId, testRunId);

    mockClerk({ userId: null });
  });

  it("should return 401 without authentication", async () => {
    const request = makeCommitRequest(testRunId, null, {
      storageName: "test",
      storageType: "volume",
      versionId: "abc123",
      files: [],
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 when storage does not exist", async () => {
    const request = makeCommitRequest(testRunId, testToken, {
      storageName: uniqueId("nonexistent"),
      storageType: "volume",
      versionId: "abc123",
      files: [],
    });

    const response = await POST(request);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("should return 400 when versionId does not match", async () => {
    const storageName = uniqueId("webhook-mismatch");
    const files = [{ path: "test.txt", hash: "a".repeat(64), size: 100 }];

    // Create storage via webhook prepare
    await prepareStorage(testRunId, testToken, storageName, "volume", files);

    // Commit with wrong versionId
    const request = makeCommitRequest(testRunId, testToken, {
      storageName,
      storageType: "volume",
      versionId: "wrong_version_id",
      files,
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toContain("mismatch");
  });

  it("should commit version and return success", async () => {
    const storageName = uniqueId("webhook-success");
    const files = [
      { path: "file1.txt", hash: "c".repeat(64), size: 100 },
      { path: "file2.txt", hash: "d".repeat(64), size: 200 },
    ];

    const versionId = await prepareStorage(
      testRunId,
      testToken,
      storageName,
      "artifact",
      files,
    );

    const request = makeCommitRequest(testRunId, testToken, {
      storageName,
      storageType: "artifact",
      versionId,
      files,
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(2);
    expect(json.size).toBe(300);
    expect(json).not.toHaveProperty("error");
  });

  it("should return deduplicated=true for idempotent re-commit", async () => {
    const storageName = uniqueId("webhook-idempotent");
    const files = [{ path: "test.txt", hash: "e".repeat(64), size: 100 }];

    const versionId = await prepareStorage(
      testRunId,
      testToken,
      storageName,
      "volume",
      files,
    );

    // First commit
    await POST(
      makeCommitRequest(testRunId, testToken, {
        storageName,
        storageType: "volume",
        versionId,
        files,
      }),
    );

    // Re-commit (idempotent)
    const response = await POST(
      makeCommitRequest(testRunId, testToken, {
        storageName,
        storageType: "volume",
        versionId,
        files,
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.deduplicated).toBe(true);
  });
});
