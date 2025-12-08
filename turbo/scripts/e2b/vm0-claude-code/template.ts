import { Template } from "e2b";

/**
 * VM0 E2B Template Configuration
 *
 * This template includes:
 * - Node.js 24.x
 * - Claude Code CLI (globally installed as "claude")
 * - curl, git, ripgrep for development
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "ripgrep"])
  .npmInstall("@anthropic-ai/claude-code@latest", { g: true });
