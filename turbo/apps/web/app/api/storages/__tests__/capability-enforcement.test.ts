import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as prepareRoute } from "../prepare/route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../src/__tests__/db-test-seeders/runs";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

// Valid SHA-256 hash for test file entries
const TEST_HASH = "a".repeat(64);

describe("Storage capability enforcement", () => {
  let userId: string;
  let runId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
    const user = await context.user;
    userId = user.userId;

    // Create a compose and run so sandbox tokens can resolve org
    const { composeId } = await createTestCompose(uniqueId("storage-agent"));
    const result = await seedTestRun(userId, composeId);
    runId = result.runId;
  });

  describe("sandbox token access for prepare", () => {
    it("should accept sandbox token with agent:write for volume prepare", async () => {
      const token = await generateSandboxToken(userId, runId, "org-test");
      mockClerk({ userId: null });

      const response = await prepareRoute(
        createTestRequest("http://localhost:3000/api/storages/prepare", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            storageName: "test-vol",
            storageType: "volume",
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(200);
    });

    it("should accept sandbox token regardless of specific capability for prepare", async () => {
      const token = await generateSandboxToken(userId, runId, "org-test");
      mockClerk({ userId: null });

      const response = await prepareRoute(
        createTestRequest("http://localhost:3000/api/storages/prepare", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            storageName: "test-vol",
            storageType: "volume",
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(200);
    });
  });
});
