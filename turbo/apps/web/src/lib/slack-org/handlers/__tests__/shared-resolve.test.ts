import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import {
  createTestOrg,
  getOrgDefaultAgent,
  updateOrgDefaultAgent,
  ensureOrgRow,
} from "../../../../__tests__/api-test-helpers";
import { resolveDefaultComposeId } from "../shared";

const context = testContext();

describe("resolveDefaultComposeId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns DB value without Clerk call", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Set default_agent_compose_id in DB
    const composeId = "00000000-0000-0000-0000-000000000001";
    await updateOrgDefaultAgent(orgId, composeId);

    const result = await resolveDefaultComposeId(orgId);
    expect(result).toBe(composeId);

    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("falls back to Clerk when DB has null, backfills DB", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;
    await ensureOrgRow(orgId);

    const clerkComposeId = "00000000-0000-0000-0000-000000000002";

    // Override getOrganization to return default_agent_compose_id
    const client = await clerkClient();
    vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
      id: orgId,
      slug,
      name: slug,
      publicMetadata: { default_agent_compose_id: clerkComposeId },
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganization>
    >);

    const result = await resolveDefaultComposeId(orgId);
    expect(result).toBe(clerkComposeId);

    // Verify backfill (fire-and-forget, wait a tick)
    await new Promise((r) => setTimeout(r, 50));
    const dbValue = await getOrgDefaultAgent(orgId);
    expect(dbValue).toBe(clerkComposeId);
  });

  it("falls through to env var fallback when DB and Clerk are empty", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;
    await ensureOrgRow(orgId);

    // Clerk returns empty publicMetadata (default mock behavior)
    // resolveDefaultAgentComposeId will also return null since VM0_DEFAULT_AGENT is not set
    const result = await resolveDefaultComposeId(orgId);
    expect(result).toBeNull();
  });
});
