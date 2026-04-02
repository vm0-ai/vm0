/**
 * Check if a runner group belongs to the official vm0 organization.
 *
 * @param group - Runner group in format "vm0/<name>"
 * @returns true if the group is an official runner group (vm0/*)
 */
export function isOfficialRunnerGroup(group: string): boolean {
  const orgSlug = group.split("/")[0];
  // TODO: Runner group public access for vm0 is hardcoded. This should be configurable.
  return orgSlug === "vm0";
}
