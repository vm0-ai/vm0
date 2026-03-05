import { getScopeBySlug } from "./scope-service";
import { requireScopeMember, getDefaultScope } from "./scope-member-service";
import { badRequest, notFound } from "../errors";

/**
 * Resolve scope from request context using scope_members.
 *
 * Resolution order:
 * 1. ?scope=<slug> query param → look up scope, verify membership
 * 2. Fallback → user's default scope (first owned scope from scope_members)
 *
 * Returns { scope, member } for the resolved scope.
 */
export async function resolveScope(userId: string, scopeSlug?: string | null) {
  // 1. Explicit scope selection via ?scope= query param
  if (scopeSlug) {
    const scope = await getScopeBySlug(scopeSlug);
    if (!scope) throw notFound("Scope not found");
    const member = await requireScopeMember(scope.id, userId);
    return { scope, member };
  }

  // 2. Default scope fallback
  return getDefaultScope(userId);
}

/**
 * Extract and validate scope from a request's ?scope= query parameter.
 * Throws if the scope param is missing, the scope doesn't exist, or the user
 * is not a member.
 *
 * Use this in org routes that always require an explicit scope parameter.
 */
export async function requireScopeFromRequest(
  request: Request,
  userId: string,
) {
  const url = new URL(request.url);
  const scopeSlug = url.searchParams.get("scope");
  if (!scopeSlug) {
    throw badRequest("scope query parameter is required");
  }
  const scope = await getScopeBySlug(scopeSlug);
  if (!scope) {
    throw notFound("Scope not found");
  }
  const member = await requireScopeMember(scope.id, userId);
  return { scope, member };
}
