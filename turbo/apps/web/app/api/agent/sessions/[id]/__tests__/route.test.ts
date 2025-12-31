/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
  });
}

// Mock the auth module
let mockUserId: string | null = "test-user-sessions";
vi.mock("../../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("GET /api/agent/sessions/:id", () => {
  const testUserId = "test-user-sessions";
  const testScopeId = randomUUID();
  const testComposeId = randomUUID();
  const testSessionId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      name: "test-session-compose",
      userId: testUserId,
      scopeId: testScopeId,
    });

    // Create test session
    await globalThis.services.db.insert(agentSessions).values({
      id: testSessionId,
      userId: testUserId,
      agentComposeId: testComposeId,
      agentComposeVersionId: "test-version-id-12345",
      vars: { testVar: "testValue" },
      secretNames: ["SECRET_1", "SECRET_2"],
      volumeVersions: { "volume-1": "v1.0.0" },
    });
  });

  afterAll(async () => {
    // Cleanup
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return session with all fields including secretNames", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${testSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(testSessionId);
    expect(data.agentComposeId).toBe(testComposeId);
    expect(data.agentComposeVersionId).toBe("test-version-id-12345");
    expect(data.vars).toEqual({ testVar: "testValue" });
    expect(data.secretNames).toEqual(["SECRET_1", "SECRET_2"]);
    expect(data.volumeVersions).toEqual({ "volume-1": "v1.0.0" });
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 404 for non-existent session", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${nonExistentId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Session not found");
  });

  it("should return 403 when accessing another user's session", async () => {
    const otherUserId = "other-user-sessions";
    const otherSessionId = randomUUID();

    // Create session for another user
    await globalThis.services.db.insert(agentSessions).values({
      id: otherSessionId,
      userId: otherUserId,
      agentComposeId: testComposeId,
      secretNames: ["OTHER_SECRET"],
    });

    // Try to access as test user
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${otherSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");

    // Cleanup
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.id, otherSessionId));
  });

  it("should return 401 when not authenticated", async () => {
    // Temporarily set mockUserId to null
    const originalUserId = mockUserId;
    mockUserId = null;

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${testSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");

    // Restore mockUserId
    mockUserId = originalUserId;
  });

  it("should handle session with null secretNames", async () => {
    const sessionWithNullSecrets = randomUUID();

    await globalThis.services.db.insert(agentSessions).values({
      id: sessionWithNullSecrets,
      userId: testUserId,
      agentComposeId: testComposeId,
      secretNames: null,
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${sessionWithNullSecrets}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.secretNames).toBeNull();

    // Cleanup
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.id, sessionWithNullSecrets));
  });
});
