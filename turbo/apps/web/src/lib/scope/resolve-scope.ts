import { getScopeBySlug } from "./scope-service";
import { requireScopeMember, getDefaultScope } from "./scope-member-service";
import { notFound } from "../errors";

/**
 * Resolve scope from request context using scope_members.
 *
 * Resolution order:
 * 1. ?scope=<slug> query param → look up scope, verify membership
 * 2. Fallback → user's default scope (first owned scope from scope_members)
 *
 * Returns { scope, member } for the resolved scope.
 */
export async function resolveScope(
  userId: string,
  _authHeader?: string,
  scopeSlug?: string | null,
) {
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
