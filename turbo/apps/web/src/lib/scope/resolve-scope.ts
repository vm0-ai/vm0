import { resolveOrgAccessToken } from "../org/org-token-service";
import { getScopeBySlug, getScopeById } from "./scope-service";
import {
  requireScopeMember,
  ensureScopeMember,
  getDefaultScope,
} from "./scope-member-service";
import { notFound } from "../errors";

/**
 * Resolve scope from request context using scope_members.
 *
 * Resolution order:
 * 1. ?scope=<slug> query param → look up scope, verify membership
 * 2. vm0_org_* token (backward compat) → resolve scope from org token
 * 3. Fallback → user's default scope (first owned scope from scope_members)
 *
 * Returns { scope, member } for the resolved scope.
 */
export async function resolveScope(
  userId: string,
  authHeader?: string,
  scopeSlug?: string | null,
) {
  // 1. Explicit scope selection via ?scope= query param
  if (scopeSlug) {
    const scope = await getScopeBySlug(scopeSlug);
    if (!scope) throw notFound("Scope not found");
    const member = await requireScopeMember(scope.id, userId);
    return { scope, member };
  }

  // 2. Backward compat: vm0_org_* token → resolve scope from token
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  if (token?.startsWith("vm0_org_")) {
    const orgAuth = await resolveOrgAccessToken(token);
    if (orgAuth) {
      const scope = await getScopeById(orgAuth.scopeId);
      if (scope) {
        // Lazy-create: org token was generated after Clerk verification,
        // so the user is a verified member — ensure scope_members record exists
        const member = await ensureScopeMember(
          scope.id,
          orgAuth.userId,
          orgAuth.role,
        );
        return { scope, member };
      }
    }
  }

  // 3. Default scope fallback
  return getDefaultScope(userId);
}
