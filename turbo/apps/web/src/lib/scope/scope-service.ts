import { createHash, randomBytes } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { scopes } from "../../db/schema/scope";
import { requireScopeMember, getDefaultScope } from "./scope-member-service";
import {
  badRequest,
  notFound,
  forbidden,
  isNotFound,
  isBadRequest,
} from "../errors";
import { logger } from "../logger";

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
export async function getScopeById(id: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, id))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Get a scope by its slug
 */
async function getScopeBySlug(slug: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.slug, slug))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Get a scope by its Clerk organization ID
 */
export async function getScopeByClerkOrgId(clerkOrgId: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.clerkOrgId, clerkOrgId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Get scopes by multiple Clerk organization IDs in a single query.
 * Returns a Map from clerkOrgId to scope record.
 */
export async function getScopesByClerkOrgIds(
  clerkOrgIds: string[],
): Promise<Map<string, typeof scopes.$inferSelect>> {
  if (clerkOrgIds.length === 0) return new Map();
  const results = await globalThis.services.db
    .select()
    .from(scopes)
    .where(inArray(scopes.clerkOrgId, clerkOrgIds));
  return new Map(results.map((s) => [s.clerkOrgId, s]));
}

/**
 * Create a scope for a user.
 *
 * Handles slug validation and scope creation.
 *
 * @param options.clerkOrgId - Clerk org ID to bind the scope to
 */
export async function createScope(
  clerkUserId: string,
  slug: string,
  options: { clerkOrgId: string },
) {
  validateScopeSlug(slug);

  // Pre-check slug availability for clear error
  const existingScope = await getScopeBySlug(slug);
  if (existingScope) {
    throw badRequest(`Scope "${slug}" already exists`);
  }

  const { clerkOrgId } = options;

  const [newScope] = await globalThis.services.db
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

  log.debug("scope created", {
    clerkUserId,
    scopeId: newScope.id,
    slug,
    clerkOrgId,
  });

  return newScope;
}

/**
 * Get a user's default scope by their Clerk ID.
 * Finds the first scope where the user is an admin member.
 * Returns the scope record or null if none found.
 */
export async function getDefaultScopeByClerkUserId(clerkUserId: string) {
  try {
    const { scope } = await getDefaultScope(clerkUserId);
    return scope;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Ensure a user has a default scope, creating one if it doesn't exist.
 * Consolidates the auto-creation pattern used by CLI token exchange,
 * Slack OAuth, and the scope API.
 *
 * In SaaS mode (Clerk auth configured), discovers existing Clerk orgs via
 * JIT API call and creates a local scope bound to the first unmatched org.
 * In self-hosted mode, falls back to creating a scope with a generated slug.
 *
 * @returns The existing or newly created scope
 */
export async function ensureDefaultScope(clerkUserId: string) {
  const existing = await getDefaultScopeByClerkUserId(clerkUserId);
  if (existing) return existing;

  return await discoverAndCreateScope(clerkUserId);
}

/**
 * Check if a slug is valid without throwing.
 * Reuses the same rules as validateScopeSlug() but returns a boolean.
 */
function isValidSlug(slug: string): boolean {
  return (
    slug.length >= 3 &&
    slug.length <= 64 &&
    SLUG_REGEX.test(slug) &&
    !RESERVED_SLUGS.includes(slug) &&
    !slug.startsWith("vm0")
  );
}

/**
 * Resolve the first Clerk org membership for a user that has no matching local scope.
 * Fetches the user's Clerk org memberships, batch-queries existing scopes, and
 * returns the first unmatched membership (or null if all orgs are already bound).
 */
export async function resolveUnmatchedClerkOrg(clerkUserId: string) {
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId: clerkUserId,
  });

  if (memberships.data.length === 0) {
    return null;
  }

  const orgIds = memberships.data.map((m) => m.organization.id);
  const matchedScopes = await globalThis.services.db
    .select({ clerkOrgId: scopes.clerkOrgId })
    .from(scopes)
    .where(inArray(scopes.clerkOrgId, orgIds));
  const existingOrgIds = new Set(matchedScopes.map((s) => s.clerkOrgId));

  return (
    memberships.data.find((m) => !existingOrgIds.has(m.organization.id)) ?? null
  );
}

/**
 * Discover an existing Clerk org for a user and create a local scope bound to it.
 * Queries the Clerk API for the user's org memberships, finds the first org
 * without a matching local scope, and creates a scope record.
 */
async function discoverAndCreateScope(clerkUserId: string) {
  const unmatchedMembership = await resolveUnmatchedClerkOrg(clerkUserId);

  if (!unmatchedMembership) {
    throw notFound(
      "No organization found. Please sign up again to create an organization.",
    );
  }

  const clerkOrgId = unmatchedMembership.organization.id;

  // Prefer Clerk org slug, fall back to deterministic user-{hash}
  const clerkSlug = unmatchedMembership.organization.slug;
  let slug: string;
  if (clerkSlug && isValidSlug(clerkSlug)) {
    const taken = await getScopeBySlug(clerkSlug);
    slug = taken ? generateDefaultScopeSlug(clerkUserId) : clerkSlug;
  } else {
    slug = generateDefaultScopeSlug(clerkUserId);
  }

  try {
    return await createScope(clerkUserId, slug, { clerkOrgId });
  } catch (error) {
    if (isBadRequest(error) && error.message.includes("already exists")) {
      // Re-check: another concurrent request may have created this scope
      const raceScope = await getScopeByClerkOrgId(clerkOrgId);
      if (raceScope) return raceScope;

      // Slug collision with unrelated scope — retry with random slug
      const fallbackSlug = `user-${randomBytes(4).toString("hex")}`;
      return await createScope(clerkUserId, fallbackSlug, { clerkOrgId });
    }
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

  // Dual-write: sync slug to Clerk org (fire-and-forget)
  try {
    const client = await clerkClient();
    await client.organizations.updateOrganization(scope.clerkOrgId, {
      slug: newSlug,
    });
  } catch (err) {
    log.error("failed to write slug to Clerk org", {
      error: err,
      clerkOrgId: scope.clerkOrgId,
      scopeId,
      newSlug,
    });
  }

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
  tokenScopeId?: string | null,
): Promise<void> {
  const scopeSlug = group.split("/")[0];
  if (!scopeSlug) {
    throw forbidden("Invalid runner group format");
  }

  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  if (scopeSlug === "vm0") {
    return;
  }

  // CLI token with stored scope_id — verify slug matches directly
  if (tokenScopeId) {
    const scope = await getScopeById(tokenScopeId);
    if (scope && scope.slug === scopeSlug) {
      return;
    }
    throw forbidden(
      `Runner group scope "${scopeSlug}" does not match your scope`,
    );
  }

  const defaultScope = await getDefaultScopeByClerkUserId(clerkUserId);
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
