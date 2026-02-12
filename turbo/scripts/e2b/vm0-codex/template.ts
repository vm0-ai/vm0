import { Template } from "e2b";

/**
 * VM0 E2B Template Configuration for Codex
 *
 * This template includes:
 * - Node.js 24.x
 * - OpenAI Codex CLI (globally installed as "codex")
 * - curl, git, ripgrep, jq, file for development
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "ripgrep", "jq", "file", "tzdata"])
  .npmInstall("@openai/codex@0.79.0", { g: true });
