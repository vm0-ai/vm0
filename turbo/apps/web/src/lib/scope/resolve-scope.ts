import { resolveOrgAccessToken } from "../org/org-token-service";
import { getUserScopeByClerkId, getScopeById } from "./scope-service";

/**
 * Resolve scope from auth context.
 *
 * If the request uses a vm0_org_* token, the scope is determined by the token.
 * Otherwise, falls back to the user's personal scope.
 */
export async function resolveScope(userId: string, authHeader?: string) {
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  if (token?.startsWith("vm0_org_")) {
    const orgAuth = await resolveOrgAccessToken(token);
    if (!orgAuth) return null;

    return getScopeById(orgAuth.scopeId);
  }

  return getUserScopeByClerkId(userId);
}
