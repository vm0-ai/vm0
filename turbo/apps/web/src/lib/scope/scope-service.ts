import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { scopes } from "../../db/schema/scope";
import { scopeMembers } from "../../db/schema/scope-member";
import {
  requireScopeMember,
  getPrimaryAdminMembership,
  getDefaultScope,
} from "./scope-member-service";
import { badRequest, notFound, forbidden, isNotFound } from "../errors";
import { logger } from "../logger";
import { env, hasClerkAuth } from "../../env";
import { SELF_HOSTED_CLERK_ORG_ID } from "../auth/constants";

const log = logger("service:scope");

/**
 * Check if an email is a VM0 admin user.
 * Admin users are defined by the VM0_ADMIN_USERS environment variable
 * (comma-separated email list).
 */
export function isVm0Admin(email: string): boolean {
  const adminUsers = env().VM0_ADMIN_USERS;
  if (!adminUsers) return false;
  const adminList = adminUsers.split(",").map((e) => e.trim().toLowerCase());
  return adminList.includes(email.toLowerCase());
}

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
 * @param clerkUserId - The Clerk user ID to hash
 * @returns A slug in format "user-xxxxxxxx" (13 chars total)
 */
export function generateDefaultScopeSlug(clerkUserId: string): string {
  const hash = createHash("sha256").update(clerkUserId).digest("hex");
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
 * Get a scope by its ID
 */
async function getScopeById(scopeId: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, scopeId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Get a scope by its slug
 */
export async function getScopeBySlug(slug: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.slug, slug))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Create a scope for a user with an admin membership.
 *
 * Merges the former createUserScope() and createOrganization() functions.
 * Handles Clerk org creation (or self-hosted fallback), slug validation,
 * one-admin-per-user constraint, and atomic scope + membership creation.
 *
 * @param options.skipSlugValidation - Skip reserved-slug checks (for vm0-admin bypass)
 */
export async function createScope(
  clerkUserId: string,
  slug: string,
  options?: { skipSlugValidation?: boolean },
) {
  // Check one-admin-per-user constraint
  const existingAdmin = await getPrimaryAdminMembership(clerkUserId);
  if (existingAdmin) {
    const [existingScope] = await globalThis.services.db
      .select({ slug: scopes.slug })
      .from(scopes)
      .where(eq(scopes.id, existingAdmin.scopeId))
      .limit(1);
    throw badRequest(
      `You already have a scope: ${existingScope?.slug ?? existingAdmin.scopeId}. Use --force to change it.`,
    );
  }

  // Validate slug (unless explicitly skipped for vm0-admin)
  if (!options?.skipSlugValidation) {
    validateScopeSlug(slug);
  }

  // Pre-check slug availability for clear error before Clerk API call
  const existingScope = await getScopeBySlug(slug);
  if (existingScope) {
    throw badRequest(`Scope "${slug}" already exists`);
  }

  // Create Clerk Organization so every scope is backed by one.
  // If Clerk auth is configured, org creation is required (fail-fast).
  // If self-hosted (no Clerk), use the well-known sentinel ID.
  let clerkOrgId: string;
  if (hasClerkAuth()) {
    const client = await clerkClient();
    const clerkOrg = await client.organizations.createOrganization({
      name: slug,
      createdBy: clerkUserId,
    });
    clerkOrgId = clerkOrg.id;
  } else {
    clerkOrgId = SELF_HOSTED_CLERK_ORG_ID;
  }

  // Create scope + admin membership atomically
  const scope = await globalThis.services.db.transaction(async (tx) => {
    const [newScope] = await tx
      .insert(scopes)
      .values({
        slug,
        clerkOrgId,
      })
      .onConflictDoNothing({ target: scopes.slug })
      .returning();

    if (!newScope) {
      throw badRequest(`Scope "${slug}" already exists`);
    }

    await tx.insert(scopeMembers).values({
      scopeId: newScope.id,
      userId: clerkUserId,
      role: "admin",
    });

    return newScope;
  });

  log.debug("scope created", {
    clerkUserId,
    scopeId: scope.id,
    slug,
    clerkOrgId,
  });

  return scope;
}

/**
 * Get a user's scope by their Clerk ID.
 * Finds the first scope where the user is an admin member.
 * Returns the scope record or null if none found.
 */
export async function getUserScopeByClerkId(clerkUserId: string) {
  try {
    const { scope } = await getDefaultScope(clerkUserId);
    return scope;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Update a scope's slug
 * Requires force flag since this can break existing references
 */
export async function updateScopeSlug(
  scopeId: string,
  newSlug: string,
  clerkUserId: string,
  force: boolean = false,
) {
  // Get the scope
  const scope = await getScopeById(scopeId);
  if (!scope) {
    throw notFound("Scope not found");
  }

  // Verify membership (requireScopeMember throws 403 if not a member)
  await requireScopeMember(scopeId, clerkUserId);

  // Require force flag for slug changes
  if (!force) {
    throw badRequest(
      "Changing scope slug may break existing references. Use --force to confirm.",
    );
  }

  validateScopeSlug(newSlug);

  // Check if new slug already exists
  const existing = await getScopeBySlug(newSlug);
  if (existing && existing.id !== scopeId) {
    throw badRequest(`Scope "${newSlug}" already exists`);
  }

  log.debug("updating scope slug", {
    scopeId,
    oldSlug: scope.slug,
    newSlug,
  });

  const [updated] = await globalThis.services.db
    .update(scopes)
    .set({
      slug: newSlug,
      updatedAt: new Date(),
    })
    .where(eq(scopes.id, scopeId))
    .returning();

  log.debug("scope slug updated", { scopeId, newSlug });

  return updated!;
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
  clerkUserId: string,
  group: string,
): Promise<void> {
  const scopeSlug = group.split("/")[0];
  if (!scopeSlug) {
    throw forbidden("Invalid runner group format");
  }

  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  if (scopeSlug === "vm0") {
    return;
  }

  // For user runner groups, validate scope ownership
  const userScope = await getUserScopeByClerkId(clerkUserId);
  if (!userScope) {
    throw forbidden(
      `Runner group scope "${scopeSlug}" requires you to have a scope configured`,
    );
  }

  if (userScope.slug !== scopeSlug) {
    throw forbidden(
      `Runner group scope "${scopeSlug}" does not match your scope "${userScope.slug}"`,
    );
  }
}
