import { randomUUID } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as listRoute } from "../list/route";
import { POST as prepareRoute } from "../prepare/route";
import { POST as commitRoute } from "../commit/route";
import { GET as downloadRoute } from "../download/route";
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
    it("should accept sandbox token with agent:read for volume list", async () => {
      await createTestVolume("test-vol");
      const token = await generateSandboxToken(userId, runId, ["agent:read"]);
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

    it("should accept sandbox token with artifact:read for artifact list", async () => {
      await createTestArtifact("test-art");
      const token = await generateSandboxToken(userId, runId, [
        "artifact:read",
      ]);
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

    it("should accept sandbox token with artifact:read for memory list", async () => {
      await createTestMemory("test-mem");
      const token = await generateSandboxToken(userId, runId, [
        "artifact:read",
      ]);
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
        "artifact:write",
      ]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("FORBIDDEN");
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

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should reject artifact:read token for volume list", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:read",
      ]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(403);
    });

    it("should reject agent:read token for artifact list", async () => {
      const token = await generateSandboxToken(userId, runId, ["agent:read"]);
      mockClerk({ userId: null });

      const response = await listRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/list?type=artifact",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(403);
    });
  });

  describe("sandbox token access for prepare", () => {
    it("should accept sandbox token with agent:write for volume prepare", async () => {
      const token = await generateSandboxToken(userId, runId, ["agent:write"]);
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

    it("should accept sandbox token with artifact:write for artifact prepare", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:write",
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
            storageName: "test-art",
            storageType: "artifact",
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(200);
    });

    it("should reject sandbox token without matching write capability for prepare", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:read",
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

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should reject artifact:write token for volume prepare", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:write",
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

      expect(response.status).toBe(403);
    });

    it("should accept artifact:write token for memory prepare", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:write",
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
            storageName: "test-mem",
            storageType: "memory",
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(200);
    });

    it("should reject agent:write token for artifact prepare", async () => {
      const token = await generateSandboxToken(userId, runId, ["agent:write"]);
      mockClerk({ userId: null });

      const response = await prepareRoute(
        createTestRequest("http://localhost:3000/api/storages/prepare", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            storageName: "test-art",
            storageType: "artifact",
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(403);
    });
  });

  describe("sandbox token access for commit", () => {
    it("should reject artifact:write token for volume commit", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:write",
      ]);
      mockClerk({ userId: null });

      const response = await commitRoute(
        createTestRequest("http://localhost:3000/api/storages/commit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            storageName: "test-vol",
            storageType: "volume",
            versionId: TEST_HASH,
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(403);
    });

    it("should reject agent:write token for artifact commit", async () => {
      const token = await generateSandboxToken(userId, runId, ["agent:write"]);
      mockClerk({ userId: null });

      const response = await commitRoute(
        createTestRequest("http://localhost:3000/api/storages/commit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            storageName: "test-art",
            storageType: "artifact",
            versionId: TEST_HASH,
            files: [{ path: "a.txt", hash: TEST_HASH, size: 10 }],
          }),
        }),
      );

      expect(response.status).toBe(403);
    });
  });

  describe("sandbox token access for download", () => {
    it("should accept agent:read token for volume download", async () => {
      await createTestVolume("test-vol");
      const token = await generateSandboxToken(userId, runId, ["agent:read"]);
      mockClerk({ userId: null });

      const response = await downloadRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/download?name=test-vol&type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      // Auth passed (not 403) — may be 200 or 404 depending on storage state
      expect(response.status).not.toBe(403);
    });

    it("should accept artifact:read token for artifact download", async () => {
      await createTestArtifact("test-art");
      const token = await generateSandboxToken(userId, runId, [
        "artifact:read",
      ]);
      mockClerk({ userId: null });

      const response = await downloadRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/download?name=test-art&type=artifact",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      // Auth passed (not 403) — may be 200 or 404 depending on storage state
      expect(response.status).not.toBe(403);
    });

    it("should reject artifact:read token for volume download", async () => {
      const token = await generateSandboxToken(userId, runId, [
        "artifact:read",
      ]);
      mockClerk({ userId: null });

      const response = await downloadRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/download?name=test-vol&type=volume",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(403);
    });

    it("should reject agent:read token for artifact download", async () => {
      const token = await generateSandboxToken(userId, runId, ["agent:read"]);
      mockClerk({ userId: null });

      const response = await downloadRoute(
        createTestRequest(
          "http://localhost:3000/api/storages/download?name=test-art&type=artifact",
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(403);
    });
  });

  describe("backward compatibility", () => {
    it("should accept CLI token without capabilities for list", async () => {
      // CLI token user is authenticated via Clerk session (getAuthContext checks Clerk first).
      // The key is that adding requiredCapability to getAuthContext doesn't break CLI/session flows.
      const cliToken = await createTestCliToken(userId);
      const orgSlug = `org-${userId.slice(-8)}`;

      const response = await listRoute(
        createTestRequest(
          `http://localhost:3000/api/storages/list?type=artifact&org=${orgSlug}`,
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
      const token = await generateSandboxToken(userId, runId, ["agent:read"]);
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
        "agent:read",
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
