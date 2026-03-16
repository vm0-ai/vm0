import { randomUUID } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as listRoute } from "../list/route";
import { POST as prepareRoute } from "../prepare/route";
import {
  createTestRequest,
  createTestVolume,
  createTestArtifact,
  createTestMemory,
  createTestCompose,
  createTestRunInDb,
  createTestCliToken,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";

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
    const { composeId } = await createTestCompose("test-agent");
    const result = await createTestRunInDb(userId, composeId);
    runId = result.runId;
  });

  describe("sandbox token access for list", () => {
    it("should accept sandbox token with storage:read for volume list", async () => {
      await createTestVolume("test-vol");
      const token = await generateSandboxToken(userId, runId, ["storage:read"]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("test-vol");
    });

    it("should accept sandbox token with storage:read for artifact list", async () => {
      await createTestArtifact("test-art");
      const token = await generateSandboxToken(userId, runId, ["storage:read"]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=artifact",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("test-art");
    });

    it("should accept sandbox token with storage:read for memory list", async () => {
      await createTestMemory("test-mem");
      const token = await generateSandboxToken(userId, runId, ["storage:read"]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=memory",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("test-mem");
    });

    it("should reject sandbox token with write capability on read route", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "storage:write",
      ]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(401);
    });

    it("should reject sandbox token with no capabilities", async () => {
      const token = await generateSandboxToken(userId, runId);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("sandbox token access for prepare", () => {
    it("should accept sandbox token with storage:write for prepare", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "storage:write",
      ]);
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

    it("should reject sandbox token without matching write capability for prepare", async () => {
      const token = await generateSandboxToken(userId, runId, ["storage:read"]);
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

      expect(response.status).toBe(401);
    });
  });

  describe("backward compatibility", () => {
    it("should accept CLI token without capabilities for list", async () => {
      // CLI token user is authenticated via Clerk session (getAuthContext checks Clerk first).
      // The key is that adding requiredCapability to getAuthContext doesn't break CLI/session flows.
      const cliToken = await createTestCliToken(userId);

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=artifact",
          { headers: { authorization: `Bearer ${cliToken}` } },
        ),
      );

      expect(response.status).toBe(200);
    });

    it("should accept session token without capabilities for list", async () => {
      // Session is already set up by context.setupUser() + setupMocks()
      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=artifact",
        ),
      );

      expect(response.status).toBe(200);
    });
  });

  describe("org resolution for sandbox tokens", () => {
    it("should use run orgId for sandbox token", async () => {
      // Create a volume in the user's org
      await createTestVolume("org-vol");

      // Sandbox token should resolve to the same org via run record
      const token = await generateSandboxToken(userId, runId, ["storage:read"]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("org-vol");
    });

    it("should return 404 when sandbox token run not found", async () => {
      const fakeRunId = randomUUID();
      const token = await generateSandboxToken(userId, fakeRunId, [
        "storage:read",
      ]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });
});
