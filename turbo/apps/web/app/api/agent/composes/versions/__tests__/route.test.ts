/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { POST } from "../../route";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

/**
 * Helper to create a NextRequest for testing.
 * Uses actual NextRequest constructor so ts-rest handler gets nextUrl property.
 */
function createTestRequest(
  url: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
    body: options?.body,
  });
}

// Mock the auth module
let mockUserId = "test-user-versions";
vi.mock("../../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("GET /api/agent/composes/versions", () => {
  const testUserId = "test-user-versions";
  let testComposeId: string;
  let testVersionId: string;

  beforeAll(async () => {
    initServices();

    // Create a test compose with a version
    const config = {
      version: "1.0",
      agents: {
        "test-version-agent": {
          description: "Test agent for version tests",
          image: "vm0/claude-code:dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    testComposeId = createData.composeId;
    testVersionId = createData.versionId;
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    if (testComposeId) {
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.composeId, testComposeId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, testComposeId));
    }
  });

  it("should resolve 'latest' to HEAD version", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=latest`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versionId).toBe(testVersionId);
    expect(data.tag).toBe("latest");
  });

  it("should resolve full hash exactly", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=${testVersionId}`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versionId).toBe(testVersionId);
  });

  it("should resolve hash prefix (8 chars)", async () => {
    const prefix = testVersionId.slice(0, 8);
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=${prefix}`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versionId).toBe(testVersionId);
  });

  it("should return 404 for nonexistent version", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=deadbeef`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Version 'deadbeef' not found");
  });

  it("should return 400 for invalid version format (too short)", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=abc`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid version format");
  });

  it("should return 400 for invalid version format (non-hex)", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=ghijklmn`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid version format");
  });

  it("should return 400 when composeId is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/versions?version=latest",
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    // Zod validation returns "expected string, received undefined" for missing required params
    expect(data.error.message).toContain("expected string");
  });

  it("should return 400 when version is missing", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    // Zod validation returns "expected string, received undefined" for missing required params
    expect(data.error.message).toContain("expected string");
  });

  it("should return 404 for nonexistent compose", async () => {
    // Use a valid UUID format that doesn't exist
    const nonexistentUuid = "00000000-0000-0000-0000-000000000000";
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${nonexistentUuid}&version=latest`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Agent compose not found");
  });

  it("should isolate versions by user", async () => {
    // Try to access compose as different user
    mockUserId = "other-user";

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=latest`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Agent compose not found");

    // Reset mockUserId
    mockUserId = testUserId;
  });

  it("should return 400 for ambiguous version prefix", async () => {
    // Create a second version with the same 8-char prefix as testVersionId
    const prefix = testVersionId.slice(0, 8);
    // Generate a different version ID with the same prefix
    const ambiguousVersionId =
      prefix + "0000000000000000000000000000000000000000000000000000000a";

    // Insert a second version with the same prefix
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: ambiguousVersionId,
      composeId: testComposeId,
      content: { version: "1.0", agents: {} },
      createdBy: testUserId,
    });

    try {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=${prefix}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Ambiguous version prefix");
      expect(data.error.message).toContain(prefix);
    } finally {
      // Cleanup: remove the ambiguous version
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, ambiguousVersionId));
    }
  });
});
