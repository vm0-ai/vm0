import {
  getUserScopeByClerkId,
  getScopeBySlug,
  canAccessScope,
} from "./scope-service";
import type { scopes } from "../../db/schema/scope";

type Scope = typeof scopes.$inferSelect;

export interface ResolvedScope {
  scope: Scope;
  error?: never;
}

export interface ScopeError {
  scope?: never;
  error: string;
  code: "NO_SCOPE" | "NOT_FOUND" | "FORBIDDEN";
}

export type ScopeResolutionResult = ResolvedScope | ScopeError;

/**
 * Resolve the scope for a request based on the X-VM0-Scope header
 *
 * Logic:
 * 1. If no header or empty → return user's personal scope
 * 2. If header present → look up scope by slug
 * 3. Verify user has access to scope
 * 4. Return scope or error
 *
 * @param clerkUserId - The authenticated user's Clerk ID
 * @param scopeHeader - The value of the X-VM0-Scope header (optional)
 * @returns The resolved scope or an error
 */
export async function resolveRequestScope(
  clerkUserId: string,
  scopeHeader?: string | null,
): Promise<ScopeResolutionResult> {
  // No header or empty → use personal scope
  if (!scopeHeader || scopeHeader.trim() === "") {
    const personalScope = await getUserScopeByClerkId(clerkUserId);
    if (!personalScope) {
      return {
        error: "No scope configured. Set your scope with: vm0 scope set <slug>",
        code: "NO_SCOPE",
      };
    }
    return { scope: personalScope };
  }

  // Header present → look up scope by slug
  const slug = scopeHeader.trim().toLowerCase();
  const scope = await getScopeBySlug(slug);

  if (!scope) {
    return {
      error: `Scope "${slug}" not found`,
      code: "NOT_FOUND",
    };
  }

  // Verify user has access to this scope
  const hasAccess = await canAccessScope(clerkUserId, scope.id);
  if (!hasAccess) {
    return {
      error: `You don't have access to scope "${slug}"`,
      code: "FORBIDDEN",
    };
  }

  return { scope };
}

/**
 * Helper to check if a scope resolution was successful
 */
export function isScopeResolutionSuccess(
  result: ScopeResolutionResult,
): result is ResolvedScope {
  return "scope" in result && result.scope !== undefined;
}
