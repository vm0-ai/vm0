import { env } from "../../env";

/**
 * Returns true if `userId` matches any entry in `EXTRA_STAFF_USER_IDS`
 * (comma-separated Clerk user IDs in `.env.local` / preview secrets).
 *
 * This is an OR-gate alongside `isStaffOrg` on endpoints that need a
 * hard staff identity check. The env var is kept gitignored and
 * populated per-engineer so nobody has to touch the hard-coded
 * `STAFF_ORG_ID_HASHES` list just to run locally.
 */
export function isExtraStaffUser(userId: string | undefined | null): boolean {
  if (!userId) return false;
  const raw = env().EXTRA_STAFF_USER_IDS;
  if (!raw) return false;
  const allowed = raw
    .split(",")
    .map((s) => {
      return s.trim();
    })
    .filter((s) => {
      return s.length > 0;
    });
  return allowed.includes(userId);
}
