import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { POST } from "../../route";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

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

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("GET /api/agent/composes/versions", () => {
  const testUserId = "test-user-versions";
  const testScopeId = randomUUID();
  let testComposeId: string;
  let testVersionId: string;

  beforeAll(async () => {
    initServices();

    // Mock headers() - return empty headers so auth falls through to Clerk
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user (required for compose creation)
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create a test compose with a version
    const config = {
      version: "1.0",
      agents: {
        "test-version-agent": {
          description: "Test agent for version tests",
          image: "vm0/claude-code:dev",
          framework: "claude-code",
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

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
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
    expect(data.error.message).toContain("8-64 hex characters");
  });

  it("should return 400 for invalid version format (non-hex)", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=ghijklmn`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("8-64 hex characters");
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
    mockAuth.mockResolvedValueOnce({
      userId: "other-user",
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=latest`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Agent compose not found");
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

  it("should resolve version created by another compose with identical content (cross-compose deduplication)", async () => {
    // This tests the fix for issue #762:
    // When two composes have identical content, the version deduplication creates
    // only one version record (linked to the first compose). The second compose's
    // HEAD points to this shared version. Version lookup should still succeed
    // for the second compose because version hashes are content-addressable.

    // Create a second compose with different name but we'll manually set up
    // a scenario where its HEAD points to a version created by a different compose
    const secondComposeConfig = {
      version: "1.0",
      agents: {
        "test-version-agent-b": {
          description: "Second agent for cross-compose test",
          image: "vm0/claude-code:dev",
          framework: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    // Create second compose
    const createRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: secondComposeConfig }),
      },
    );

    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    const secondComposeId = createData.composeId;
    const secondVersionId = createData.versionId;

    try {
      // Now manually update the second compose's headVersionId to point to
      // the first compose's version (simulating the deduplication scenario)
      await globalThis.services.db
        .update(agentComposes)
        .set({ headVersionId: testVersionId })
        .where(eq(agentComposes.id, secondComposeId));

      // The key test: resolve testVersionId using secondComposeId
      // This should succeed even though testVersionId was created by testComposeId
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/versions?composeId=${secondComposeId}&version=${testVersionId.slice(0, 8)}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      // Should succeed - version lookup doesn't require composeId match
      expect(response.status).toBe(200);
      expect(data.versionId).toBe(testVersionId);
    } finally {
      // Cleanup: Delete second compose and its version
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, secondVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, secondComposeId));
    }
  });

  it("should resolve version with full hash for cross-compose scenario", async () => {
    // Similar to above but tests exact match (64-char hash) instead of prefix match

    const secondComposeConfig = {
      version: "1.0",
      agents: {
        "test-version-agent-c": {
          description: "Third agent for cross-compose exact match test",
          image: "vm0/claude-code:dev",
          framework: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: secondComposeConfig }),
      },
    );

    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    const thirdComposeId = createData.composeId;
    const thirdVersionId = createData.versionId;

    try {
      // Update HEAD to point to first compose's version
      await globalThis.services.db
        .update(agentComposes)
        .set({ headVersionId: testVersionId })
        .where(eq(agentComposes.id, thirdComposeId));

      // Test with full 64-char hash
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/versions?composeId=${thirdComposeId}&version=${testVersionId}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.versionId).toBe(testVersionId);
    } finally {
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, thirdVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, thirdComposeId));
    }
  });
});
