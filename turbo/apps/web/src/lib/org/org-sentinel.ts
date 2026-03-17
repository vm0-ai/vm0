/** Sentinel userId for org-level resources (model providers, secrets, variables) */
export const ORG_SENTINEL_USER_ID = "__org__";

/** Check if a userId represents an org-level resource */
export function isOrgLevel(userId: string): boolean {
  return userId === ORG_SENTINEL_USER_ID;
}
