import { Template } from "e2b";

/**
 * VM0 GitHub CLI Template Configuration
 *
 * This template includes:
 * - Node.js 24.x
 * - Claude Code CLI (globally installed as "claude")
 * - curl, git, ripgrep for development
 * - GitHub CLI (gh) for GitHub operations
 */
export const template = Template()
  .fromNodeImage("24")
  .aptInstall(["curl", "git", "ripgrep"])
  .npmInstall("@anthropic-ai/claude-code@latest", { g: true })
  // Install GitHub CLI
  .runCmd(
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
  )
  .runCmd(
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
  )
  .runCmd("sudo apt-get update")
  .aptInstall(["gh"]);
