/**
 * Calculate session history path based on working directory and agent type
 * Matches logic from events.py.ts
 *
 * @param workingDir Working directory path
 * @param sessionId Session ID (Claude) or Thread ID (Codex)
 * @param agentType CLI agent type (defaults to "claude-code")
 * @returns Full path to session history file
 */
export function calculateSessionHistoryPath(
  workingDir: string,
  sessionId: string,
  agentType: string = "claude-code",
): string {
  const homeDir = "/home/user";

  if (agentType === "codex") {
    // Codex stores sessions in ~/.codex/sessions/
    const codexHome = `${homeDir}/.codex`;
    return `${codexHome}/sessions/${sessionId}.jsonl`;
  } else {
    // Claude Code uses ~/.claude (default, no CLAUDE_CONFIG_DIR override)
    // Path encoding: e.g., /home/user/workspace -> -home-user-workspace
    const projectName = workingDir.replace(/^\//, "").replace(/\//g, "-");
    return `${homeDir}/.claude/projects/-${projectName}/${sessionId}.jsonl`;
  }
}
