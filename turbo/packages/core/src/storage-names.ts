/**
 * Storage name generation functions for agent instructions and skills.
 * These functions create standardized storage names used across CLI and Web packages.
 */

/**
 * Sentinel userId for scope-level storages (volumes).
 * Volumes are shared resources within a scope — they use this constant
 * instead of a real userId so the (orgId, userId, name, type)
 * constraint keeps them unique per org, not per user.
 */
export const VOLUME_SCOPE_USER_ID = "__scope__";

/**
 * Generate the storage name for agent instructions.
 * Format: agent-instructions@{agentName}
 *
 * @param agentName - Name of the agent (compose name)
 * @returns Storage name for the instructions
 */
export function getInstructionsStorageName(agentName: string): string {
  return `agent-instructions@${agentName}`;
}

/**
 * Generate the storage name for an agent skill.
 * Format: agent-skills@{fullPath}
 *
 * @param fullPath - Full path from GitHub URL (e.g., "owner/repo/tree/branch/path")
 * @returns Storage name for the skill
 */
export function getSkillStorageName(fullPath: string): string {
  return `agent-skills@${fullPath}`;
}
