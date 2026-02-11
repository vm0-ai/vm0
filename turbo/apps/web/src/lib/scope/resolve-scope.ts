import { eq } from "drizzle-orm";
import { resolveOrgAccessToken } from "../org/org-token-service";
import { getUserScopeByClerkId } from "./scope-service";
import { scopes } from "../../db/schema/scope";

/**
 * Extract the Bearer token from an authorization header
 */
function extractToken(authHeader?: string): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.substring(7);
}

/**
 * Resolve scope from auth context.
 *
 * If the request uses a vm0_org_* token, the scope is determined by the token.
 * Otherwise, falls back to the user's personal scope.
 */
export async function resolveScope(userId: string, authHeader?: string) {
  const token = extractToken(authHeader);

  if (token?.startsWith("vm0_org_")) {
    const orgAuth = await resolveOrgAccessToken(token);
    if (!orgAuth) return null;

    const [scope] = await globalThis.services.db
      .select()
      .from(scopes)
      .where(eq(scopes.id, orgAuth.scopeId))
      .limit(1);

    return scope ?? null;
  }

  return getUserScopeByClerkId(userId);
}
