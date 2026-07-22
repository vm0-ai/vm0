import { Template } from "e2b";

/**
 * Zero CLI E2B Template Configuration
 *
 * This template includes:
 * - Node.js 24.x
 * - Zero CLI (globally installed as "zero")
 * - curl, git, jq for compose operations
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "jq", "tzdata"])
  .npmInstall("@vm0/cli@9.59.1", { g: true });
