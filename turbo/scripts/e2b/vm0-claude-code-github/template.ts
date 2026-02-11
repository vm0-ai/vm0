import { Template } from "e2b";

/**
 * VM0 E2B Template Configuration with GitHub CLI
 *
 * This template includes:
 * - Node.js 24.x
 * - Claude Code CLI (globally installed as "claude")
 * - curl, git, ripgrep, jq, file for development
 * - GitHub CLI (gh) for GitHub integration
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "ripgrep", "jq", "file", "tzdata"])
  .npmInstall("@anthropic-ai/claude-code@2.1.27", { g: true })
  // Install GitHub CLI
  // https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  .runCmd(
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
    { user: "root" },
  )
  .runCmd(
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
    { user: "root" },
  )
  .runCmd("apt-get update && apt-get install -y gh", { user: "root" });
