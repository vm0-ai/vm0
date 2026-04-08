import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCliToken,
  insertOrgCacheEntry,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

function makeOrgSwitchRequest(slug: string, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return createTestRequest("http://localhost:3000/api/cli/auth/org", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug }),
  });
}

describe("POST /api/cli/auth/org", () => {
  let user: UserContext;
  let cliToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    cliToken = await createTestCliToken(user.userId);
  });

  it("should return 200 with new JWT when switching to valid org", async () => {
    // setupUser already creates org_cache for the default org.
    // Insert membership cache so getMemberRole succeeds without Clerk call.
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });

    // Get the org slug from org_cache (setupUser uses org-${suffix} pattern)
    // We need to look it up — use the orgId to find the slug.
    // Actually, setupUser creates slug as `org-${suffix}` and orgId as `org_mock_${userId}`.
    // We can derive slug from userId: suffix is the last 8 chars of userId after "test-user-".
    // But easier: create a known org with a known slug.
    const slug = uniqueId("switch-org");
    const orgId = uniqueId("org");
    await insertOrgCacheEntry({ orgId, slug });
    await insertOrgMembersCacheEntry({
      orgId,
      userId: user.userId,
      role: "member",
    });

    const response = await POST(makeOrgSwitchRequest(slug, cliToken));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.access_token).toMatch(/^vm0_pat_/);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(90 * 24 * 60 * 60);
  });

  it("should return 401 when not authenticated", async () => {
    // Override Clerk mock to return no session (simulates truly unauthenticated request)
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/cli/auth/org",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "some-org" }),
      },
    );

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("should return 404 when org slug does not exist", async () => {
    const response = await POST(
      makeOrgSwitchRequest("nonexistent-org-slug", cliToken),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("should return 403 when user is not a member of the org", async () => {
    // Create an org the user is NOT a member of
    const slug = uniqueId("other-org");
    const orgId = uniqueId("org");
    await insertOrgCacheEntry({ orgId, slug });
    // No membership cache entry — and Clerk mock won't return this org either

    const response = await POST(makeOrgSwitchRequest(slug, cliToken));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("should return 400 when slug is missing from body", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/cli/auth/org",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cliToken}`,
        },
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("should return 400 when slug is empty string", async () => {
    const response = await POST(makeOrgSwitchRequest("", cliToken));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });
});
