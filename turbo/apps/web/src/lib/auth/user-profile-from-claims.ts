import type { AuthContext } from "./get-auth-context";

interface UserProfile {
  email: string;
  name: string | null;
}

/**
 * Project a Clerk session's claims into { email, name } for system-prompt
 * seeding. Returns undefined when the caller is not a session token, when
 * claims are absent, or when the email claim is missing/empty — callers must
 * fall back to `getCachedUser(userId)` in those cases.
 *
 * `name` matches user-cache-service's derivation byte-for-byte:
 *   [first, last].filter(Boolean).join(" ") || null
 * so prompt output is stable regardless of which source produced the profile.
 */
export function userProfileFromClaims(
  authCtx: AuthContext,
): UserProfile | undefined {
  if (authCtx.tokenType !== "session") return undefined;
  const claims = authCtx.sessionClaims;
  if (!claims) return undefined;
  if (typeof claims.email !== "string" || claims.email.length === 0) {
    return undefined;
  }
  const first =
    typeof claims.first_name === "string" ? claims.first_name : null;
  const last = typeof claims.last_name === "string" ? claims.last_name : null;
  const name = [first, last].filter(Boolean).join(" ") || null;
  return { email: claims.email, name };
}
