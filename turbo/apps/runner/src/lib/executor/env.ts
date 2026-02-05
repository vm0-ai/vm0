/**
 * Executor Environment
 *
 * Environment variable building for agent execution in Firecracker VMs.
 */

import type { ExecutionContext } from "../api.js";
import { VM_PROXY_CA_PATH } from "../vm-setup/index.js";

/**
 * Path to environment JSON file in VM
 * Used by run-agent.py to load environment variables
 */
export const ENV_JSON_PATH = "/tmp/vm0-env.json";

/**
 * Build environment variables for the agent execution
 */
export function buildEnvironmentVariables(
  context: ExecutionContext,
  apiUrl: string,
): Record<string, string> {
  const envVars: Record<string, string> = {
    VM0_API_URL: apiUrl,
    VM0_RUN_ID: context.runId,
    VM0_API_TOKEN: context.sandboxToken,
    VM0_PROMPT: context.prompt,
    VM0_WORKING_DIR: context.workingDir,
    VM0_API_START_TIME: context.apiStartTime?.toString() ?? "",
    CLI_AGENT_TYPE: context.cliAgentType || "claude-code",
  };

  // Add Vercel bypass if available
  const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (vercelBypass) {
    envVars.VERCEL_PROTECTION_BYPASS = vercelBypass;
  }

  // Pass USE_MOCK_CLAUDE from host environment for testing (skip if debugNoMockClaude is set)
  const useMockClaude = process.env.USE_MOCK_CLAUDE;
  if (useMockClaude && !context.debugNoMockClaude) {
    envVars.USE_MOCK_CLAUDE = useMockClaude;
  }

  // Add artifact configuration if present
  if (context.storageManifest?.artifact) {
    const artifact = context.storageManifest.artifact;
    envVars.VM0_ARTIFACT_DRIVER = "vas";
    envVars.VM0_ARTIFACT_MOUNT_PATH = artifact.mountPath;
    envVars.VM0_ARTIFACT_VOLUME_NAME = artifact.vasStorageName;
    envVars.VM0_ARTIFACT_VERSION_ID = artifact.vasVersionId;
  }

  // Add resume session ID if present
  if (context.resumeSession) {
    envVars.VM0_RESUME_SESSION_ID = context.resumeSession.sessionId;
  }

  // Add user environment variables
  if (context.environment) {
    Object.assign(envVars, context.environment);
  }

  // Add secret values for masking (base64 encoded, comma separated)
  if (context.secretValues && context.secretValues.length > 0) {
    envVars.VM0_SECRET_VALUES = context.secretValues
      .map((v) => Buffer.from(v).toString("base64"))
      .join(",");
  }

  // Add user-defined vars
  if (context.vars) {
    for (const [key, value] of Object.entries(context.vars)) {
      envVars[key] = value;
    }
  }

  // For MITM mode, tell Node.js to trust the proxy CA certificate
  // This is required because mitmproxy intercepts HTTPS traffic and re-signs
  // certificates with its own CA. Without this, Node.js will reject the connection.
  // Note: Python and curl automatically use the system CA bundle.
  if (context.experimentalFirewall?.experimental_mitm) {
    envVars.NODE_EXTRA_CA_CERTS = VM_PROXY_CA_PATH;
  }

  return envVars;
}
