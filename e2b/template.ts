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
export const template = Template()
  .fromImage("e2bdev/base")
  // Install Node.js 22.x
  .runCmd("curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -")
  .runCmd("sudo apt-get install -y nodejs")
  // Verify Node.js installation
  .runCmd("node --version")
  .runCmd("npm --version")
  // Clear npm cache to force fresh install
  .runCmd("sudo npm cache clean --force")
  // Install Claude Code CLI globally with verbose output
  .runCmd("sudo npm install -g @anthropic-ai/claude-code --verbose")
  // Verify Claude Code was actually installed
  .runCmd(
    "ls -la /usr/local/lib/node_modules/ | grep claude || echo 'ERROR: Claude Code not in node_modules'",
  )
  .runCmd(
    "ls -la /usr/local/bin/ | grep claude || echo 'ERROR: Claude binary not in bin'",
  )
  .runCmd(
    "npm list -g @anthropic-ai/claude-code || echo 'ERROR: Claude Code not in npm list'",
  )
  // Try to run claude --version
  .runCmd(
    "/usr/local/bin/claude --version || echo 'ERROR: Cannot execute claude'",
  )
  // Install required tools for webhooks
  .runCmd("sudo apt-get update")
  .runCmd("sudo apt-get install -y curl jq")
  // Create workspace directory (use absolute path)
  .runCmd("mkdir -p /home/user/workspace")
  // Create VM0 directory for scripts
  .runCmd("sudo mkdir -p /opt/vm0")
  .runCmd("sudo chmod 755 /opt/vm0")
  // Copy run-agent.sh script to /usr/local/bin/ (like uspark approach)
  .copy("./run-agent.sh", "/tmp/run-agent.sh")
  .runCmd("sudo mv /tmp/run-agent.sh /usr/local/bin/run-agent.sh")
  .runCmd("sudo chmod +x /usr/local/bin/run-agent.sh")
  // Verify installations
  .runCmd("which curl")
  .runCmd("which jq")
  .runCmd("test -f /usr/local/bin/run-agent.sh && echo 'SUCCESS: run-agent.sh installed' || (echo 'FATAL: run-agent.sh missing' && exit 1)")
  .runCmd('echo "VM0 Claude Code template ready!"')
  // Final verification - this should fail the build if Claude is not installed
  .runCmd(
    "test -f /usr/local/bin/claude && echo 'SUCCESS: Claude Code installed' || (echo 'FATAL: Claude Code missing' && exit 1)",
  );
