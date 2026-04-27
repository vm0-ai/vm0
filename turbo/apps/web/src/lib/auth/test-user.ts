import { clerkClient } from "@clerk/nextjs/server";
import { desc, eq } from "drizzle-orm";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import {
  getOrgMetadata,
  type OrgMetadata,
} from "../zero/org/org-metadata-service";

export const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";

/**
 * Resolve the test user ID by querying Clerk Backend API for the e2e test user.
 * Throws if the user is not found (accounts must be pre-provisioned by CI).
 *
 * @param email - the email address of the test user to look up
 */
export async function resolveTestUserId(
  email: string = DEFAULT_TEST_EMAIL,
): Promise<string> {
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });
  const userId = users[0]?.id;
  if (!userId) {
    throw new Error(`Test user not found for email: ${email}`);
  }
  return userId;
}

/**
 * Look up the test user's org + metadata via org_members_cache → org_metadata.
 *
 * Returns `null` when the user has no cached membership at all (e.g.
 * `test-token` was never called to seed caches). `test-token` also upserts
 * `org_metadata` for the resolved org, so the metadata lookup should
 * always succeed once that endpoint has run — hence we let NotFound from
 * `getOrgMetadata` bubble up rather than masking it with a fallback.
 */
export async function resolveTestUserOrg(
  userId: string,
): Promise<OrgMetadata | null> {
  const [cached] = await globalThis.services.db
    .select({ orgId: orgMembersCache.orgId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.userId, userId))
    .orderBy(desc(orgMembersCache.cachedAt))
    .limit(1);
  if (!cached) return null;
  return getOrgMetadata(cached.orgId);
}

/**
 * Pick a deterministic Clerk org for a test user.
 *
 * If the test user accumulates multiple orgs (e.g. through CI test
 * pollution), Clerk does not guarantee iteration order. Sort by
 * membership `createdAt` ascending so every caller targets the oldest
 * org — both `ensureTestOrg` (CLI test-token route) and the Slack
 * test-state seeder resolve to the same org.
 *
 * Throws if the user has no memberships.
 */
export async function resolveTestOrgId(userId: string): Promise<string> {
  const clerk = await clerkClient();
  const memberships = await clerk.users.getOrganizationMembershipList({
    userId,
  });
  const sorted = [...memberships.data].sort((a, b) => {
    return a.createdAt - b.createdAt;
  });
  const orgId = sorted[0]?.organization.id;
  if (!orgId) {
    throw new Error(`Test user ${userId} has no organization membership`);
  }
  return orgId;
}
