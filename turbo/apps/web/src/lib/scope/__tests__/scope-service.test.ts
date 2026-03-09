import { describe, it, expect, beforeEach, vi } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { createTestScope } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { reloadEnv } from "../../../env";
import { getScopeByClerkOrgId } from "../scope-service";
import { SELF_HOSTED_CLERK_ORG_ID } from "../../auth/constants";

const context = testContext();

describe("getScopeByClerkOrgId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return scope for valid clerkOrgId", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    mockClerk({ userId });

    const created = await createTestScope(slug);

    // Clerk mock generates clerkOrgId as "org_mock_{slug}"
    const result = await getScopeByClerkOrgId(`org_mock_${slug}`);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(created.id);
    expect(result!.slug).toBe(slug);
  });

  it("should return null for non-existent clerkOrgId", async () => {
    const result = await getScopeByClerkOrgId("org_nonexistent_xyz");

    expect(result).toBeNull();
  });

  it("should handle self-hosted sentinel org_self_hosted", async () => {
    // Simulate self-hosted mode by removing Clerk keys
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    reloadEnv();

    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    mockClerk({ userId });

    await createTestScope(slug);

    const result = await getScopeByClerkOrgId(SELF_HOSTED_CLERK_ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.clerkOrgId).toBe(SELF_HOSTED_CLERK_ORG_ID);
  });
});
