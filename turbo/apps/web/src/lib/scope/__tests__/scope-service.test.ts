import { describe, it, expect, beforeEach } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { createTestScope } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { getScopeByOrgId, createScope } from "../scope-service";

const context = testContext();

describe("getScopeByOrgId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return scope for valid orgId", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    mockClerk({ userId });

    const created = await createTestScope(slug);

    // POST route resolves orgId from user's Clerk org membership (org_mock_{userId})
    const result = await getScopeByOrgId(`org_mock_${userId}`);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(created.id);
    expect(result!.slug).toBe(slug);
  });

  it("should return null for non-existent orgId", async () => {
    const result = await getScopeByOrgId("org_nonexistent_xyz");

    expect(result).toBeNull();
  });
});

describe("createScope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should use provided orgId instead of creating a new Clerk org", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    const existingOrgId = `org_existing_${slug}`;
    mockClerk({ userId });

    const scope = await createScope(userId, slug, {
      orgId: existingOrgId,
    });

    expect(scope.slug).toBe(slug);
    expect(scope.orgId).toBe(existingOrgId);

    // Verify Clerk createOrganization was NOT called
    const client = await clerkClient();
    expect(client.organizations.createOrganization).not.toHaveBeenCalled();
  });

  it("should require orgId parameter", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    const orgId = `org_required_${slug}`;
    mockClerk({ userId });

    const scope = await createScope(userId, slug, { orgId });

    expect(scope.slug).toBe(slug);
    expect(scope.orgId).toBe(orgId);
  });
});
