/**
 * VM Setup Operations
 *
 * SSH-based setup operations for Firecracker VMs.
 * These functions configure the VM environment before agent execution.
 */

import fs from "fs";
import type { SSHClient } from "../firecracker/guest.js";
import type { StorageManifest, ResumeSession } from "../api.js";
import { getAllScripts } from "../scripts/utils.js";
import { SCRIPT_PATHS } from "../scripts/index.js";

/**
 * Upload all scripts to VM individually via SSH
 * Scripts are installed to /usr/local/bin which requires sudo
 */
export async function uploadScripts(ssh: SSHClient): Promise<void> {
  const scripts = getAllScripts();

  // Create directory (requires sudo for /usr/local/bin)
  // No lib directory needed - scripts are self-contained ESM bundles
  await ssh.execOrThrow(`sudo mkdir -p ${SCRIPT_PATHS.baseDir}`);

  // Write each script file individually using sudo tee
  for (const script of scripts) {
    await ssh.writeFileWithSudo(script.path, script.content);
  }

  // Set executable permissions (requires sudo)
  await ssh.execOrThrow(
    `sudo chmod +x ${SCRIPT_PATHS.baseDir}/*.mjs 2>/dev/null || true`,
  );
}

/**
 * Download storages to VM using storage manifest
 */
export async function downloadStorages(
  ssh: SSHClient,
  manifest: StorageManifest,
): Promise<void> {
  // Count archives to download
  const totalArchives =
    manifest.storages.filter((s) => s.archiveUrl).length +
    (manifest.artifact?.archiveUrl ? 1 : 0);

  if (totalArchives === 0) {
    console.log(`[Executor] No archives to download`);
    return;
  }

  console.log(`[Executor] Downloading ${totalArchives} archive(s)...`);

  // Write manifest to VM
  const manifestJson = JSON.stringify(manifest);
  await ssh.writeFile("/tmp/storage-manifest.json", manifestJson);

  // Run download script
  const result = await ssh.exec(
    `node ${SCRIPT_PATHS.download} /tmp/storage-manifest.json`,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Storage download failed: ${result.stderr}`);
  }

  console.log(`[Executor] Storage download completed`);
}

/**
 * Restore session history for resume functionality
 */
export async function restoreSessionHistory(
  ssh: SSHClient,
  resumeSession: ResumeSession,
  workingDir: string,
  cliAgentType: string,
): Promise<void> {
  const { sessionId, sessionHistory } = resumeSession;

  // Calculate session history path based on CLI agent type
  let sessionPath: string;
  if (cliAgentType === "codex") {
    // Codex uses different path structure - for now use a marker
    // The checkpoint.py will search for the actual file
    console.log(
      `[Executor] Codex resume session will be handled by checkpoint.py`,
    );
    return;
  } else {
    // Claude Code path: ~/.claude/projects/-{path}/{session_id}.jsonl
    const projectName = workingDir.replace(/^\//, "").replace(/\//g, "-");
    sessionPath = `/home/user/.claude/projects/-${projectName}/${sessionId}.jsonl`;
  }

  console.log(`[Executor] Restoring session history to ${sessionPath}`);

  // Create directory and write file
  const dirPath = sessionPath.substring(0, sessionPath.lastIndexOf("/"));
  await ssh.execOrThrow(`mkdir -p "${dirPath}"`);
  await ssh.writeFile(sessionPath, sessionHistory);

  console.log(
    `[Executor] Session history restored (${sessionHistory.split("\n").length} lines)`,
  );
}

/**
 * Install proxy CA certificate in VM for network security mode
 * This allows the VM to trust the runner's mitmproxy for HTTPS interception
 *
 * @param ssh - SSH client connected to the VM
 * @param caCertPath - Path to the CA certificate file on the runner host
 */
export async function installProxyCA(
  ssh: SSHClient,
  caCertPath: string,
): Promise<void> {
  // Read CA certificate from runner host
  if (!fs.existsSync(caCertPath)) {
    throw new Error(
      `Proxy CA certificate not found at ${caCertPath}. Run generate-proxy-ca.sh first.`,
    );
  }

  const caCert = fs.readFileSync(caCertPath, "utf-8");
  console.log(
    `[Executor] Installing proxy CA certificate (${caCert.length} bytes)`,
  );

  // Write CA cert to VM's CA certificates directory
  await ssh.writeFileWithSudo(
    "/usr/local/share/ca-certificates/vm0-proxy-ca.crt",
    caCert,
  );

  // Update CA certificates (requires sudo)
  await ssh.execOrThrow("sudo update-ca-certificates");
  console.log(`[Executor] Proxy CA certificate installed successfully`);
}

/**
 * Configure DNS in the VM
 * Systemd-resolved may overwrite /etc/resolv.conf at boot,
 * so we need to ensure DNS servers are configured after SSH is ready.
 * Requires sudo since we're connected as 'user', not root.
 */
export async function configureDNS(ssh: SSHClient): Promise<void> {
  // Remove any symlink and write static DNS configuration
  // Use sudo since /etc/resolv.conf requires root access
  const dnsConfig = `nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1`;

  await ssh.execOrThrow(
    `sudo sh -c 'rm -f /etc/resolv.conf && echo "${dnsConfig}" > /etc/resolv.conf'`,
  );
}
