import { getZeroOrg } from "../../../lib/api/domains/zero-orgs";

type UserRole = "admin" | "member" | "unknown";

/**
 * Best-effort role detection for the current user.
 *
 * Calls the org API to retrieve the caller's role.
 * Returns "unknown" when the API call fails (no auth, network error, etc.)
 * so callers can fall back to generic messaging.
 */
export async function resolveRole(): Promise<UserRole> {
  // Intentional: doctor commands must work even without API access (no token,
  // network error, etc.). Catching all errors and falling back to "unknown"
  // lets callers degrade to generic messaging instead of crashing the CLI.
  try {
    const org = await getZeroOrg();
    if (org.role === "admin" || org.role === "member") {
      return org.role;
    }
    return "unknown";
  } catch (error: unknown) {
    console.debug("resolveRole failed, falling back to unknown:", error);
    return "unknown";
  }
}
