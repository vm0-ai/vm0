/**
 * Storage name generation functions for agent instructions and skills.
 * These functions create standardized storage names used across CLI and Web packages.
 */

/**
 * Sentinel userId for org-level storages (volumes).
 * Volumes are shared resources within an org — they use this constant
 * instead of a real userId so the (orgId, userId, name, type)
 * constraint keeps them unique per org, not per user.
 */
export const VOLUME_ORG_USER_ID = "__org__";

/**
 * Sentinel orgId for system-level storages (shared across all orgs).
 * Used for official skills that are cached globally, not per-org.
 */
export const SYSTEM_ORG_ID = "__system__";

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

/**
 * Generate the storage name for a custom skill.
 * Format: custom-skill@{skillName}
 *
 * @param skillName - Name of the custom skill (e.g., "my-skill")
 * @returns Storage name for the custom skill
 */
export function getCustomSkillStorageName(skillName: string): string {
  return `custom-skill@${skillName}`;
}

/**
 * Reserved name of the per-user "memory" artifact that Zero auto-injects into
 * every agent run. Stored as an artifact (type='artifact') scoped per user,
 * and mounted into the sandbox at a framework-specific path.
 */
export const MEMORY_ARTIFACT_NAME = "memory";
