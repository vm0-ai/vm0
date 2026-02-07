import { Template } from "e2b";

/**
 * VM0 CLI E2B Template Configuration
 *
 * This template includes:
 * - Node.js 24.x
 * - vm0 CLI (globally installed as "vm0")
 * - curl, git, jq for compose operations
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "jq"])
  .npmInstall("@vm0/cli@9.22.0", { g: true });
