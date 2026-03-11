import { describe, it, expect, beforeEach } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { createTestScope } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { getScopeByClerkOrgId, createScope } from "../scope-service";

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

    // POST route resolves clerkOrgId from user's Clerk org membership (org_mock_{userId})
    const result = await getScopeByClerkOrgId(`org_mock_${userId}`);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(created.id);
    expect(result!.slug).toBe(slug);
  });

  it("should return null for non-existent clerkOrgId", async () => {
    const result = await getScopeByClerkOrgId("org_nonexistent_xyz");

    expect(result).toBeNull();
  });
});

describe("createScope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should use provided clerkOrgId instead of creating a new Clerk org", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    const existingClerkOrgId = `org_existing_${slug}`;
    mockClerk({ userId });

    const scope = await createScope(userId, slug, {
      clerkOrgId: existingClerkOrgId,
    });

    expect(scope.slug).toBe(slug);
    expect(scope.clerkOrgId).toBe(existingClerkOrgId);

    // Verify Clerk createOrganization was NOT called
    const client = await clerkClient();
    expect(client.organizations.createOrganization).not.toHaveBeenCalled();
  });

  it("should require clerkOrgId parameter", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    const clerkOrgId = `org_required_${slug}`;
    mockClerk({ userId });

    const scope = await createScope(userId, slug, { clerkOrgId });

    expect(scope.slug).toBe(slug);
    expect(scope.clerkOrgId).toBe(clerkOrgId);
  });
});
