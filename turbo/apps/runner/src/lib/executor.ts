/**
 * Job Executor
 *
 * Executes agent jobs inside Firecracker VMs.
 * Handles VM lifecycle, script injection via vsock, and job completion.
 */

import { FirecrackerVM, type VMConfig } from "./firecracker/vm.js";
import { VsockClient, createVMVsockClient } from "./firecracker/vsock.js";
import type { ExecutionContext } from "./api.js";
import type { RunnerConfig } from "./config.js";

/**
 * Execution result
 */
export interface ExecutionResult {
  exitCode: number;
  error?: string;
}

/**
 * Bootstrap script template
 * This minimal Python script:
 * 1. Runs the Claude CLI with the prompt
 * 2. Sends events via webhook (simplified)
 * 3. Calls the complete API when done
 */
const BOOTSTRAP_SCRIPT = `#!/usr/bin/env python3
"""
VM0 Runner Bootstrap Script
Simplified agent execution for self-hosted runner.
"""
import os
import sys
import subprocess
import json
import urllib.request
import urllib.error

# Configuration from environment
API_URL = os.environ.get("VM0_API_URL", "")
RUN_ID = os.environ.get("VM0_RUN_ID", "")
API_TOKEN = os.environ.get("VM0_API_TOKEN", "")
PROMPT = os.environ.get("VM0_PROMPT", "")
WORKING_DIR = os.environ.get("VM0_WORKING_DIR", "/workspace")
VERCEL_BYPASS = os.environ.get("VERCEL_PROTECTION_BYPASS", "")

def log(msg):
    """Log message to stderr."""
    print(f"[vm0-runner] {msg}", file=sys.stderr)

def http_post(url, data):
    """Make HTTP POST request with JSON body."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_TOKEN}",
    }
    if VERCEL_BYPASS:
        headers["x-vercel-protection-bypass"] = VERCEL_BYPASS

    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        log(f"HTTP error: {e}")
        return False

def complete(exit_code, error=None):
    """Call complete API to signal job completion."""
    url = f"{API_URL}/api/webhooks/agent/complete"
    data = {"runId": RUN_ID, "exitCode": exit_code}
    if error:
        data["error"] = error

    log(f"Calling complete API: exitCode={exit_code}")
    if http_post(url, data):
        log("Complete API called successfully")
    else:
        log("Failed to call complete API")

def main():
    """Main execution logic."""
    log(f"Starting agent for run {RUN_ID}")
    log(f"Working directory: {WORKING_DIR}")
    log(f"API URL: {API_URL}")

    # Validate configuration
    if not all([API_URL, RUN_ID, API_TOKEN, PROMPT]):
        error = "Missing required environment variables"
        log(error)
        complete(1, error)
        return 1

    # Create and change to working directory
    os.makedirs(WORKING_DIR, exist_ok=True)
    os.chdir(WORKING_DIR)

    # Build Claude command
    # Use --print for output, --dangerously-skip-permissions for non-interactive
    cmd = [
        "claude",
        "--print",
        "--dangerously-skip-permissions",
        PROMPT
    ]

    log(f"Running: {' '.join(cmd)}")

    exit_code = 0
    error_msg = None

    try:
        # Execute Claude CLI
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600  # 1 hour timeout
        )

        exit_code = result.returncode

        # Print output
        if result.stdout:
            print(result.stdout)

        if exit_code != 0:
            error_msg = result.stderr or f"Claude exited with code {exit_code}"
            log(f"Agent failed: {error_msg}")
        else:
            log("Agent completed successfully")

    except subprocess.TimeoutExpired:
        exit_code = 124
        error_msg = "Agent execution timed out"
        log(error_msg)
    except Exception as e:
        exit_code = 1
        error_msg = str(e)
        log(f"Agent execution error: {error_msg}")

    # Signal completion
    complete(exit_code, error_msg)

    return exit_code

if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * VM ID counter for unique TAP devices
 */
let vmIdCounter = 0;

/**
 * Get next VM ID
 */
function getNextVmId(): number {
  return ++vmIdCounter;
}

/**
 * Execute a job in a Firecracker VM
 */
export async function executeJob(
  context: ExecutionContext,
  config: RunnerConfig,
): Promise<ExecutionResult> {
  const vmId = getNextVmId();
  let vm: FirecrackerVM | null = null;
  let vsock: VsockClient | null = null;

  console.log(`[Executor] Starting job ${context.runId} in VM ${vmId}`);

  try {
    // Create VM configuration
    const vmConfig: VMConfig = {
      vmId,
      vcpus: config.sandbox.vcpu,
      memoryMb: config.sandbox.memory_mb,
      kernelPath: config.firecracker.kernel,
      rootfsPath: config.firecracker.rootfs,
      firecrackerBinary: config.firecracker.binary,
    };

    // Create and start VM
    console.log(`[Executor] Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);
    await vm.start();

    // Get vsock path for host-guest communication
    const vsockPath = vm.getVsockPath();
    console.log(`[Executor] VM ${vmId} started, vsock at ${vsockPath}`);

    // Create vsock client and wait for vm0-agent to be reachable
    vsock = createVMVsockClient(vsockPath);
    console.log(`[Executor] Waiting for vm0-agent on vsock...`);
    await vsock.waitUntilReachable(120000, 2000); // 2 minute timeout, check every 2s

    console.log(`[Executor] vm0-agent ready on vsock`);

    // Create working directory
    const workingDir = "/workspace";
    await vsock.mkdir(workingDir);

    // Set up environment variables
    const envVars: Record<string, string> = {
      VM0_API_URL: context.apiUrl,
      VM0_RUN_ID: context.runId,
      VM0_API_TOKEN: context.sandboxToken,
      VM0_PROMPT: context.prompt,
      VM0_WORKING_DIR: workingDir,
    };

    // Add Vercel bypass if available
    const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (vercelBypass) {
      envVars.VERCEL_PROTECTION_BYPASS = vercelBypass;
    }

    // Add user-defined variables
    if (context.vars) {
      for (const [key, value] of Object.entries(context.vars)) {
        envVars[key] = value;
      }
    }

    // Write bootstrap script to VM via vsock
    console.log(`[Executor] Injecting bootstrap script...`);
    await vsock.writeFile("/tmp/vm0-bootstrap.py", BOOTSTRAP_SCRIPT);
    await vsock.execOrThrow("chmod +x /tmp/vm0-bootstrap.py");

    // Build environment export string
    const envExports = Object.entries(envVars)
      .map(([key, value]) => {
        // Escape single quotes in value
        const escapedValue = value.replace(/'/g, "'\"'\"'");
        return `export ${key}='${escapedValue}'`;
      })
      .join(" && ");

    // Execute the bootstrap script
    console.log(`[Executor] Running agent...`);
    const startTime = Date.now();

    const result = await vsock.exec(
      `${envExports} && python3 /tmp/vm0-bootstrap.py`,
    );

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `[Executor] Agent finished in ${duration}s with exit code ${result.exitCode}`,
    );

    // Log output for debugging
    if (result.stdout) {
      console.log(`[Executor] stdout: ${result.stdout.substring(0, 500)}...`);
    }
    if (result.stderr) {
      console.log(`[Executor] stderr: ${result.stderr.substring(0, 500)}...`);
    }

    return {
      exitCode: result.exitCode,
      error: result.exitCode !== 0 ? result.stderr || undefined : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Executor] Job ${context.runId} failed: ${errorMsg}`);

    return {
      exitCode: 1,
      error: errorMsg,
    };
  } finally {
    // Always cleanup VM
    if (vm) {
      console.log(`[Executor] Cleaning up VM ${vmId}...`);
      try {
        await vm.kill();
      } catch (error) {
        console.error(
          `[Executor] Failed to cleanup VM ${vmId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
