import { Template } from "e2b";

/**
 * VM0 E2B Template Configuration
 *
 * This template includes:
 * - Node.js 22.x
 * - Claude Code CLI
 * - curl and jq for webhook communication
 * - VM0 workspace directory
 */
export const vm0Template = Template()
  .fromImage("e2bdev/base")
  // Install Node.js 22.x
  .runCmd("curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -")
  .runCmd("sudo apt-get install -y nodejs")
  // Install Claude Code CLI globally
  .runCmd("sudo npm install -g @anthropic-ai/claude-code")
  // Verify Claude Code installation
  .runCmd("claude --version")
  // Install required tools for webhooks
  .runCmd("sudo apt-get update")
  .runCmd("sudo apt-get install -y curl jq")
  // Create workspace directory (use absolute path)
  .runCmd("mkdir -p /home/user/workspace")
  // Create VM0 directory for scripts
  .runCmd("sudo mkdir -p /opt/vm0")
  .runCmd("sudo chmod 755 /opt/vm0")
  // Verify installations
  .runCmd("which curl")
  .runCmd("which jq")
  .runCmd('echo "VM0 Claude Code template ready!"');
