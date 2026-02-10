import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { POST as commitPOST } from "../../commit/route";
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

    mockClerk({ userId: null });
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

    // Commit → persist version in DB
    const commitRequest = createTestRequest(
      "http://localhost:3000/api/webhooks/agent/storages/commit",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify({
          runId: testRunId,
          storageName,
          storageType: "volume",
          versionId,
          files,
        }),
      },
    );
    await commitPOST(commitRequest);

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
