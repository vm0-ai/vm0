import { describe, it, expect, beforeEach } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import {
  createTestOrg,
  insertOrgCacheEntry,
  deleteOrgCacheEntry,
  updateOrgTier,
  ensureOrgRow,
} from "../../../../__tests__/api-test-helpers";
import { getOrgData, getOrgBySlug } from "../org-cache-service";

const context = testContext();

describe("getOrgData", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("combines Clerk identity with tier from org_metadata", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    await updateOrgTier(orgId, "pro");

    const result = await getOrgData(orgId);

    expect(result.tier).toBe("pro");
    expect(result.slug).toBe(slug);
    expect(result.orgId).toBe(orgId);
  });

  it("fetches from Clerk on cache miss and returns composed data", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    await deleteOrgCacheEntry(orgId);

    const result = await getOrgData(orgId);

    expect(result).toEqual({
      orgId,
      slug,
      name: slug,
      tier: "free",
    });

    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: orgId,
    });
  });

  it("returns cached identity without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    await insertOrgCacheEntry({
      orgId,
      slug: "cached-slug",
    });

    const result = await getOrgData(orgId);

    expect(result).toEqual({
      orgId,
      slug: "cached-slug",
      name: "cached-slug",
      tier: "free",
    });

    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });
});

describe("getOrgBySlug", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("combines Clerk identity with tier from org_metadata", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug, name: slug }],
    });

    await insertOrgCacheEntry({ orgId, slug });
    await ensureOrgRow(orgId);
    await updateOrgTier(orgId, "pro");

    const result = await getOrgBySlug(slug);

    expect(result).toEqual({ orgId, slug, name: slug, tier: "pro" });

    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("returns null when slug not found in Clerk", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const result = await getOrgBySlug("nonexistent-slug");

    expect(result).toBeNull();
  });
});
