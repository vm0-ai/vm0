import { createHash } from "crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { requireScopeMember, getDefaultScope } from "./scope-member-service";
import {
  getOrgData,
  getOrgBySlug,
  invalidateOrgCache,
} from "./org-cache-service";
import { badRequest, forbidden, isNotFound } from "../errors";
import { logger } from "../logger";
import type { ResolvedScope } from "./resolve-scope";

const log = logger("service:scope");

/**
 * Reserved scope slugs that cannot be used by users
 */
const RESERVED_SLUGS = ["vm0", "system", "admin", "api", "app", "www"];

/**
 * Scope slug validation regex
 * Rules:
 * - 3-64 characters (or 1-2 for single/double char slugs)
 * - lowercase letters, numbers, and hyphens only
 * - must start and end with alphanumeric
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/;

/**
 * Generate a deterministic default scope slug from Clerk user ID.
 * Format: user-{8 hex chars from SHA-256 hash}
 *
 * @param userId - The Clerk user ID to hash
 * @returns A slug in format "user-xxxxxxxx" (13 chars total)
 */
export function generateDefaultScopeSlug(userId: string): string {
  const hash = createHash("sha256").update(userId).digest("hex");
  return `user-${hash.slice(0, 8)}`;
}

/**
 * Validate scope slug format
 */
function validateScopeSlug(slug: string): void {
  if (slug.length < 3 || slug.length > 64) {
    throw badRequest("Scope slug must be between 3 and 64 characters");
  }

  if (!SLUG_REGEX.test(slug)) {
    throw badRequest(
      "Scope slug must contain only lowercase letters, numbers, and hyphens, and must start and end with an alphanumeric character",
    );
  }

  // TODO: "vm0" is hardcoded as the system scope slug. This should be configurable.
  if (RESERVED_SLUGS.includes(slug) || slug.startsWith("vm0")) {
    throw badRequest(`Scope slug "${slug}" is reserved`);
  }
}

/**
 * Get a user's default scope by their Clerk ID.
 * Finds the first scope where the user is an admin member.
 * Returns the scope record or null if none found.
 */
export async function getDefaultScopeByUserId(
  userId: string,
): Promise<ResolvedScope | null> {
  try {
    const { scope } = await getDefaultScope(userId);
    return scope;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Update a scope's slug.
 * Updates the Clerk org slug and refreshes org_cache.
 * Requires force flag since this can break existing references.
 */
export async function updateScopeSlug(
  orgId: string,
  newSlug: string,
  userId: string,
  force: boolean = false,
): Promise<ResolvedScope> {
  // Verify membership (requireScopeMember throws 403 if not a member)
  await requireScopeMember(orgId, userId);

  // Require force flag for slug changes
  if (!force) {
    throw badRequest(
      "Changing scope slug may break existing references. Use --force to confirm.",
    );
  }

  validateScopeSlug(newSlug);

  // Check if new slug already exists via org_cache
  const existing = await getOrgBySlug(newSlug);
  if (existing && existing.orgId !== orgId) {
    throw badRequest(`Scope "${newSlug}" already exists`);
  }

  log.debug("updating scope slug", { orgId, newSlug });

  // Primary write: update Clerk org slug
  const client = await clerkClient();
  await client.organizations.updateOrganization(orgId, {
    slug: newSlug,
  });

  log.debug("scope slug updated", { orgId, newSlug });

  // Invalidate stale cache, then re-fetch from Clerk
  await invalidateOrgCache(orgId);
  return await getOrgData(orgId);
}

/**
 * Check if a runner group belongs to the official vm0 scope.
 * Official runner groups (vm0/production, vm0/development) can be used by any user.
 *
 * @param group - Runner group in format "scope/name"
 * @returns true if the group is an official runner group (vm0/*)
 */
export function isOfficialRunnerGroup(group: string): boolean {
  const scopeSlug = group.split("/")[0];
  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  return scopeSlug === "vm0";
}

/**
 * Validate that a runner group's scope matches the user's scope.
 * Runner groups are in format "scope/name" (e.g., "e2e-stable/pr-851").
 *
 * For official runner groups (vm0/*), any authenticated user is allowed.
 * For user runner groups, the scope part must match the user's personal scope slug.
 *
 * @throws ForbiddenError if scope doesn't match (for non-official groups)
 */
export async function validateRunnerGroupScope(
  userId: string,
  group: string,
  tokenOrgId?: string | null,
): Promise<void> {
  const scopeSlug = group.split("/")[0];
  if (!scopeSlug) {
    throw forbidden("Invalid runner group format");
  }

  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  if (scopeSlug === "vm0") {
    return;
  }

  // CLI token with stored org_id — resolve slug from org_cache
  if (tokenOrgId) {
    const orgData = await getOrgData(tokenOrgId);
    if (orgData.slug === scopeSlug) {
      return;
    }
    throw forbidden(
      `Runner group scope "${scopeSlug}" does not match your scope`,
    );
  }

  const defaultScope = await getDefaultScopeByUserId(userId);
  if (!defaultScope) {
    throw forbidden(
      `Runner group scope "${scopeSlug}" requires you to have a scope configured`,
    );
  }

  if (defaultScope.slug !== scopeSlug) {
    throw forbidden(
      `Runner group scope "${scopeSlug}" does not match your scope "${defaultScope.slug}"`,
    );
  }
}
