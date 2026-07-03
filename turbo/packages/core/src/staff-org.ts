import { STAFF_ORG_ID_HASHES, fnv1a } from "./identity-hash";

/**
 * Hard identity check: is this org one of the vm0 internal staff orgs?
 *
 * Intended as an authorization boundary — unlike feature switches, this
 * helper is NOT influenced by `user_feature_switches` overrides or any
 * runtime toggle. Callers can rely on it as a true yes/no gate for
 * internal-only endpoints.
 *
 * Modifying `STAFF_ORG_ID_HASHES` affects every consumer of this helper;
 * treat the list as a privileged allow-list.
 */
export function isStaffOrg(orgId: string | undefined | null): boolean {
  if (!orgId) return false;
  return STAFF_ORG_ID_HASHES.includes(fnv1a(orgId));
}
