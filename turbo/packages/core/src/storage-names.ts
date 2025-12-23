/**
 * Storage name generation functions for agent instructions and skills.
 * These functions create standardized storage names used across CLI and Web packages.
 */

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
