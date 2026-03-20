import { sql } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { requireOrgMember } from "./org-member-service";
import {
  getOrgData,
  getOrgBySlug,
  invalidateOrgCache,
} from "./org-cache-service";
import { badRequest, forbidden } from "../errors";
import { logger } from "../logger";
import { verifyMembershipCached } from "./org-membership-cache";
import type { ResolvedOrg } from "./resolve-org";

const log = logger("service:org");

/**
 * Reserved org slugs that cannot be used by users
 */
const RESERVED_SLUGS = ["vm0", "system", "admin", "api", "app", "www"];

/**
 * Org slug validation regex
 * Rules:
 * - 3-64 characters (or 1-2 for single/double char slugs)
 * - lowercase letters, numbers, and hyphens only
 * - must start and end with alphanumeric
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/;

/**
 * Validate org slug format
 */
function validateOrgSlug(slug: string): void {
  if (slug.length < 3 || slug.length > 64) {
    throw badRequest("Org slug must be between 3 and 64 characters");
  }

  if (!SLUG_REGEX.test(slug)) {
    throw badRequest(
      "Org slug must contain only lowercase letters, numbers, and hyphens, and must start and end with an alphanumeric character",
    );
  }

  // TODO: "vm0" is hardcoded as the system org slug. This should be configurable.
  if (RESERVED_SLUGS.includes(slug) || slug.startsWith("vm0")) {
    throw badRequest(`Org slug is reserved`);
  }
}

/**
 * Update an org's slug.
 * Updates the Clerk org slug and refreshes org_cache.
 * Requires force flag since this can break existing references.
 */
export async function updateOrgSlug(
  orgId: string,
  newSlug: string,
  userId: string,
  force: boolean = false,
): Promise<ResolvedOrg> {
  // Verify membership (requireOrgMember throws 403 if not a member)
  await requireOrgMember(orgId, userId);

  // Require force flag for slug changes
  if (!force) {
    throw badRequest(
      "Changing org slug may break existing references. Use --force to confirm.",
    );
  }

  validateOrgSlug(newSlug);

  // Check if new slug already exists via org_cache
  const existing = await getOrgBySlug(newSlug);
  if (existing && existing.orgId !== orgId) {
    throw badRequest(`Org "${newSlug}" already exists`);
  }

  log.debug("updating org slug", { orgId, newSlug });

  // Primary write: update Clerk org slug
  const client = await clerkClient();
  await client.organizations.updateOrganization(orgId, {
    slug: newSlug,
  });

  log.debug("org slug updated", { orgId, newSlug });

  // Invalidate stale cache, then re-fetch from Clerk
  await invalidateOrgCache(orgId);
  return await getOrgData(orgId);
}

/**
 * Check if a runner group belongs to the official vm0 org.
 * Official runner groups (vm0/production, vm0/development) can be used by any user.
 *
 * @param group - Runner group in format "org/name"
 * @returns true if the group is an official runner group (vm0/*)
 */
export function isOfficialRunnerGroup(group: string): boolean {
  const orgSlug = group.split("/")[0];
  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  return orgSlug === "vm0";
}

/**
 * Validate that a runner group's org matches the user's org.
 * Runner groups are in format "org/name" (e.g., "e2e-stable/pr-851").
 *
 * For official runner groups (vm0/*), any authenticated user is allowed.
 * For user runner groups, verifies membership via org_members_cache.
 *
 * @throws ForbiddenError if org doesn't match (for non-official groups)
 */
export async function validateRunnerGroupOrg(
  userId: string,
  group: string,
): Promise<void> {
  const orgSlug = group.split("/")[0];
  if (!orgSlug) {
    throw forbidden("Invalid runner group format");
  }

  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  if (orgSlug === "vm0") {
    return;
  }

  // Look up the org by slug, then verify membership via cache
  const orgData = await getOrgBySlug(orgSlug);
  if (!orgData) {
    throw forbidden(
      `Runner group org "${orgSlug}" requires you to have an org configured`,
    );
  }

  const membership = await verifyMembershipCached(orgData.orgId, userId);
  if (!membership) {
    throw forbidden(`Runner group org "${orgSlug}" does not match your org`);
  }
}

/**
 * Atomically deduct credits from an org's balance.
 *
 * Uses INSERT ON CONFLICT UPDATE so the row is created with `-amount`
 * if it doesn't exist, or decremented if it does.
 *
 * Accepts a Drizzle transaction so the deduction can be part of
 * a larger atomic operation (e.g. credit processing).
 */
export async function deductOrgCredits(
  tx: Parameters<Parameters<typeof globalThis.services.db.transaction>[0]>[0],
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${-amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits - ${amount}, updated_at = now()`,
  );
}

/**
 * Atomically grant credits to an org's balance (inverse of deductOrgCredits).
 *
 * Credits rollover (accumulate) — adds to existing balance.
 * Uses the same INSERT ON CONFLICT pattern as deductOrgCredits.
 */
export async function grantOrgCredits(
  tx: Parameters<Parameters<typeof globalThis.services.db.transaction>[0]>[0],
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${amount}, updated_at = now()`,
  );
}
