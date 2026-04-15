import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
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
import { randomUUID, createHash } from "crypto";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

const TEST_HASH =
  "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e";

function makePrepareRequest(
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
    "http://localhost:3000/api/webhooks/agent/checkpoints/prepare-history",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/webhooks/agent/checkpoints/prepare-history", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("prep-history"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
    testToken = await createTestSandboxToken(user.userId, testRunId);
  });

  describe("Authentication", () => {
    it("should reject without authentication", async () => {
      const request = makePrepareRequest(null, {
        runId: testRunId,
        hash: TEST_HASH,
        size: 1024,
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      const tokenForNonExistent = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = makePrepareRequest(tokenForNonExistent, {
        runId: nonExistentRunId,
        hash: TEST_HASH,
        size: 1024,
      });

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Validation", () => {
    it("should reject invalid hash format", async () => {
      const request = makePrepareRequest(testToken, {
        runId: testRunId,
        hash: "not-a-valid-hash",
        size: 1024,
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe("Success", () => {
    it("should return presigned URL for new blob", async () => {
      // Use a per-invocation unique content so repeated test runs against a
      // shared dev DB don't collide with blobs pre-registered by prior runs.
      const content = `test-content-${randomUUID()}`;
      const hash = createHash("sha256").update(content).digest("hex");

      const request = makePrepareRequest(testToken, {
        runId: testRunId,
        hash,
        size: content.length,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.existing).toBe(false);
      expect(data.presignedUrl).toBeDefined();
      expect(typeof data.presignedUrl).toBe("string");
    });

    it("should return existing=true for blob already in DB and S3", async () => {
      // Pre-seed the blob via the service layer + upload to S3
      const content = Buffer.from("pre-existing-content", "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");

      const { uploadS3Buffer } =
        await import("../../../../../../../src/lib/infra/s3/s3-client");
      const bucketName = "test-storages-bucket";
      await uploadS3Buffer(bucketName, `blobs/${hash}.blob`, content);

      const { registerSessionHistoryBlob } =
        await import("../../../../../../../src/lib/infra/session-history/session-history-service");
      await registerSessionHistoryBlob(hash);

      const request = makePrepareRequest(testToken, {
        runId: testRunId,
        hash,
        size: content.length,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.existing).toBe(true);
      expect(data.presignedUrl).toBeUndefined();
    });
  });
});
