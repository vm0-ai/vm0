import { createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { users } from "../../db/schema/user";
import { BadRequestError, NotFoundError, ForbiddenError } from "../errors";
import { logger } from "../logger";
import type { ScopeType } from "../../db/schema/scope";
import { isSystemScope } from "@vm0/core";

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
export function validateScopeSlug(slug: string): void {
  if (slug.length < 3 || slug.length > 64) {
    throw new BadRequestError("Scope slug must be between 3 and 64 characters");
  }

  if (!SLUG_REGEX.test(slug)) {
    throw new BadRequestError(
      "Scope slug must contain only lowercase letters, numbers, and hyphens, and must start and end with an alphanumeric character",
    );
  }

  if (RESERVED_SLUGS.includes(slug) || slug.startsWith("vm0")) {
    throw new BadRequestError(`Scope slug "${slug}" is reserved`);
  }
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
 * Get a scope by its ID
 */
export async function getScopeById(scopeId: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, scopeId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Get a user's personal scope
 * Returns null if user has no scope set
 */
export async function getUserScope(userId: string) {
  // First get the user to find their scope_id
  const userResult = await globalThis.services.db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = userResult[0];
  if (!user?.scopeId) {
    return null;
  }

  return getScopeById(user.scopeId);
}

/**
 * Create a new scope
 */
export async function createScope(
  slug: string,
  type: ScopeType,
  ownerId?: string,
  displayName?: string,
) {
  validateScopeSlug(slug);

  // Check if slug already exists
  const existing = await getScopeBySlug(slug);
  if (existing) {
    throw new BadRequestError(`Scope "${slug}" already exists`);
  }

  log.debug("creating scope", { slug, type, ownerId });

  const [scope] = await globalThis.services.db
    .insert(scopes)
    .values({
      slug,
      type,
      ownerId,
      displayName,
    })
    .returning();

  log.debug("scope created", { scopeId: scope!.id, slug });

  return scope!;
}

/**
 * Create a personal scope for a user and link it to their user record
 * This is the main entry point for setting up a user's scope
 */
export async function createUserScope(
  clerkUserId: string,
  slug: string,
  displayName?: string,
) {
  // First check if user already has a scope via ownerId
  const existingScope = await globalThis.services.db
    .select()
    .from(scopes)
    .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")))
    .limit(1);

  if (existingScope.length > 0) {
    throw new BadRequestError(
      `You already have a scope: ${existingScope[0]!.slug}. Use --force to change it.`,
    );
  }

  // Create the scope
  const scope = await createScope(slug, "personal", clerkUserId, displayName);

  log.debug("user scope created", { clerkUserId, scopeId: scope.id, slug });

  return scope;
}

/**
 * Get a user's scope by their Clerk ID
 */
export async function getUserScopeByClerkId(clerkUserId: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")))
    .limit(1);

  return result[0] ?? null;
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
    throw new NotFoundError("Scope not found");
  }

  // Verify ownership
  if (scope.ownerId !== clerkUserId) {
    throw new ForbiddenError("You don't have permission to modify this scope");
  }

  // System scopes cannot be changed
  if (scope.type === "system") {
    throw new ForbiddenError("System scopes cannot be modified");
  }

  // Require force flag for slug changes
  if (!force) {
    throw new BadRequestError(
      "Changing scope slug may break existing references. Use --force to confirm.",
    );
  }

  validateScopeSlug(newSlug);

  // Check if new slug already exists
  const existing = await getScopeBySlug(newSlug);
  if (existing && existing.id !== scopeId) {
    throw new BadRequestError(`Scope "${newSlug}" already exists`);
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
 * Check if a user can access a scope (read)
 * - Personal scopes: only owner
 * - Organization scopes: members (future)
 * - System scopes: everyone
 */
export async function canAccessScope(
  clerkUserId: string,
  scopeId: string,
): Promise<boolean> {
  const scope = await getScopeById(scopeId);
  if (!scope) return false;

  // System scopes are public
  if (scope.type === "system") return true;

  // Personal scopes: owner only
  if (scope.type === "personal") {
    return scope.ownerId === clerkUserId;
  }

  // Organization scopes: check membership (future)
  return false;
}

/**
 * Check if a user can write to a scope
 * - Personal scopes: only owner
 * - Organization scopes: members with write access (future)
 * - System scopes: no one (except system)
 */
export async function canWriteToScope(
  clerkUserId: string,
  scopeId: string,
): Promise<boolean> {
  const scope = await getScopeById(scopeId);
  if (!scope) return false;

  // System scopes cannot be written to by users
  if (scope.type === "system") return false;

  // Personal scopes: owner only
  if (scope.type === "personal") {
    return scope.ownerId === clerkUserId;
  }

  // Organization scopes: check write permission (future)
  return false;
}

/**
 * Assert that a user can access a scope, throwing an error if not
 */
export async function assertScopeAccess(
  clerkUserId: string,
  scopeId: string,
): Promise<void> {
  const canAccess = await canAccessScope(clerkUserId, scopeId);
  if (!canAccess) {
    throw new ForbiddenError("You don't have access to this scope");
  }
}

/**
 * Assert that a user can write to a scope, throwing an error if not
 */
export async function assertScopeWriteAccess(
  clerkUserId: string,
  scopeId: string,
): Promise<void> {
  const canWrite = await canWriteToScope(clerkUserId, scopeId);
  if (!canWrite) {
    throw new ForbiddenError("You don't have write access to this scope");
  }
}

/**
 * Check if a runner group belongs to the official vm0 system scope.
 * Official runner groups (vm0/production, vm0/development) can be used by any user.
 *
 * @param group - Runner group in format "scope/name"
 * @returns true if the group is an official runner group (vm0/*)
 */
export function isOfficialRunnerGroup(group: string): boolean {
  const scopeSlug = group.split("/")[0];
  return scopeSlug ? isSystemScope(scopeSlug) : false;
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
    throw new ForbiddenError("Invalid runner group format");
  }

  // Official runner groups (vm0/*) are accessible to all authenticated users
  if (isSystemScope(scopeSlug)) {
    return;
  }

  // For user runner groups, validate scope ownership
  const userScope = await getUserScopeByClerkId(clerkUserId);
  if (!userScope) {
    throw new ForbiddenError(
      `Runner group scope "${scopeSlug}" requires you to have a scope configured`,
    );
  }

  if (userScope.slug !== scopeSlug) {
    throw new ForbiddenError(
      `Runner group scope "${scopeSlug}" does not match your scope "${userScope.slug}"`,
    );
  }
}
