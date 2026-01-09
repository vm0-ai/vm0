import { Template } from "e2b";

/**
 * VM0 E2B Template Configuration
 *
 * This template includes:
 * - Node.js 24.x
 * - Claude Code CLI (globally installed as "claude")
 * - curl, git, ripgrep, jq, file for development
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "ripgrep", "jq", "file"])
  .npmInstall("@anthropic-ai/claude-code@2.1.2", { g: true });
