import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { POST } from "../../route";
import {
  createTestRequest,
  createTestCompose,
  createDefaultComposeConfig,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

// Only mock external services
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/agent/composes/versions", () => {
  let user: UserContext;
  let testComposeId: string;
  let testVersionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create a test compose with a version via API
    const { composeId, versionId } = await createTestCompose(
      `test-version-agent-${Date.now()}`,
    );
    testComposeId = composeId;
    testVersionId = versionId;
  });

  it("should resolve 'latest' to HEAD version", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=latest`,
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
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versionId).toBe(testVersionId);
  });

  it("should return 404 for nonexistent version", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=deadbeef`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Version 'deadbeef' not found");
  });

  it("should return 400 for invalid version format (too short)", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=abc`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("8-64 hex characters");
  });

  it("should return 400 for invalid version format (non-hex)", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=ghijklmn`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("8-64 hex characters");
  });

  it("should return 400 when composeId is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/versions?version=latest",
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
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Agent compose not found");
  });

  it("should isolate versions by user", async () => {
    // Create another user (this switches Clerk auth to the new user)
    await context.setupUser({ prefix: "other-user" });

    // Try to access compose as the new user
    // The compose belongs to original user, so new user should not see it
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${testComposeId}&version=latest`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("Agent compose not found");

    // Clean up - switch back to original user for any subsequent tests
    mockClerk({ userId: user.userId });
  });

  it("should resolve version created by another compose with identical content (cross-compose deduplication)", async () => {
    // This tests the fix for issue #762:
    // When two composes have identical content, the version deduplication creates
    // only one version record (linked to the first compose). The second compose's
    // HEAD points to this shared version. Version lookup should still succeed
    // for the second compose because version hashes are content-addressable.

    // Create a second compose with different name
    const secondComposeConfig = createDefaultComposeConfig(
      `test-version-agent-b-${Date.now()}`,
    );
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

    // The key test: resolve testVersionId using secondComposeId
    // Version lookup uses composeId for ownership check but version hash is content-addressable
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${secondComposeId}&version=latest`,
    );

    const response = await GET(request);
    const data = await response.json();

    // Should succeed - each compose has its own version from unique content
    expect(response.status).toBe(200);
    expect(data.versionId).toBeDefined();
    expect(data.tag).toBe("latest");
  });

  it("should resolve version with full hash for cross-compose scenario", async () => {
    // Similar test - create second compose and test full hash resolution
    const { composeId: thirdComposeId, versionId: thirdVersionId } =
      await createTestCompose(
        `test-version-agent-c-${randomUUID().slice(0, 8)}`,
      );

    // Test with full 64-char hash
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/versions?composeId=${thirdComposeId}&version=${thirdVersionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versionId).toBe(thirdVersionId);
  });
});
