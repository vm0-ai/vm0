/**
 * Network Setup for Firecracker VMs
 *
 * Handles TAP device creation, bridge setup, and NAT configuration.
 * This allows VMs to have outbound internet access for webhook communication.
 *
 * Network topology:
 *   VM (172.16.0.2+) <-> TAP <-> Bridge (vm0br0, 172.16.0.1) <-> NAT <-> Host Network
 */

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Network configuration for a VM
 */
export interface VMNetworkConfig {
  tapDevice: string;
  guestMac: string;
  guestIp: string;
  gatewayIp: string;
  netmask: string;
}

/**
 * Bridge configuration
 */
export const BRIDGE_NAME = "vm0br0";
export const BRIDGE_IP = "172.16.0.1";
const BRIDGE_NETMASK = "255.255.255.0";
const BRIDGE_CIDR = "172.16.0.0/24";

/**
 * Simple hash function to convert a string to a number
 * Used for generating unique MAC/IP from string vmId
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a MAC address for a VM
 * Uses the vm0 OUI prefix (locally administered) with hashed VM ID
 */
export function generateMacAddress(vmId: string): string {
  // Locally administered MAC: 02:xx:xx:xx:xx:xx
  // Use hash of vmId for last 3 bytes to ensure uniqueness
  const hash = hashString(vmId);
  const b1 = (hash >> 16) & 0xff;
  const b2 = (hash >> 8) & 0xff;
  const b3 = hash & 0xff;
  return `02:00:00:${b1.toString(16).padStart(2, "0")}:${b2.toString(16).padStart(2, "0")}:${b3.toString(16).padStart(2, "0")}`;
}

/**
 * Generate an IP address for a VM within the bridge subnet
 * VM IPs start at 172.16.0.2 (172.16.0.1 is the bridge)
 */
export function generateGuestIp(vmId: string): string {
  // Guest IPs: 172.16.0.2 - 172.16.0.254
  const hash = hashString(vmId);
  const lastOctet = (hash % 253) + 2;
  return `172.16.0.${lastOctet}`;
}

/**
 * Check if a command exists
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a shell command with error handling
 */
async function execCommand(cmd: string, sudo: boolean = true): Promise<string> {
  const fullCmd = sudo ? `sudo ${cmd}` : cmd;
  try {
    const { stdout } = await execAsync(fullCmd);
    return stdout.trim();
  } catch (error) {
    const execError = error as { stderr?: string; message?: string };
    throw new Error(
      `Command failed: ${fullCmd}\n${execError.stderr || execError.message}`,
    );
  }
}

/**
 * Get the default network interface (the one used to reach the internet)
 */
async function getDefaultInterface(): Promise<string> {
  // Get the interface used to reach 8.8.8.8
  const result = await execCommand(`ip route get 8.8.8.8`, false);
  // Output format: "8.8.8.8 via X.X.X.X dev <interface> ..."
  const match = result.match(/dev\s+(\S+)/);
  if (match && match[1]) {
    return match[1];
  }
  throw new Error(`Failed to detect default network interface from: ${result}`);
}

/**
 * Set up iptables FORWARD rules for VM traffic
 * Docker sets FORWARD chain policy to DROP, so we need explicit rules
 */
async function setupForwardRules(): Promise<void> {
  const extIface = await getDefaultInterface();
  console.log(`Setting up FORWARD rules for ${BRIDGE_NAME} <-> ${extIface}`);

  // Allow outbound traffic from VM bridge to external interface
  try {
    await execCommand(
      `iptables -C FORWARD -i ${BRIDGE_NAME} -o ${extIface} -j ACCEPT`,
    );
    console.log("FORWARD outbound rule already exists");
  } catch {
    await execCommand(
      `iptables -I FORWARD -i ${BRIDGE_NAME} -o ${extIface} -j ACCEPT`,
    );
    console.log("FORWARD outbound rule added");
  }

  // Allow return traffic from external interface to VM bridge
  try {
    await execCommand(
      `iptables -C FORWARD -i ${extIface} -o ${BRIDGE_NAME} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
    );
    console.log("FORWARD inbound rule already exists");
  } catch {
    await execCommand(
      `iptables -I FORWARD -i ${extIface} -o ${BRIDGE_NAME} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
    );
    console.log("FORWARD inbound rule added");
  }
}

/**
 * Check if bridge exists
 */
export async function bridgeExists(): Promise<boolean> {
  try {
    await execCommand(`ip link show ${BRIDGE_NAME}`, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set up the bridge device for VM networking
 * This only needs to be done once on the host
 */
export async function setupBridge(): Promise<void> {
  // Check if bridge already exists
  if (await bridgeExists()) {
    console.log(`Bridge ${BRIDGE_NAME} already exists`);
    // Still ensure FORWARD rules are set up (they may be missing after reboot or Docker restart)
    await setupForwardRules();
    return;
  }

  console.log(`Creating bridge ${BRIDGE_NAME}...`);

  // Create bridge
  await execCommand(`ip link add name ${BRIDGE_NAME} type bridge`);

  // Assign IP address to bridge
  await execCommand(
    `ip addr add ${BRIDGE_IP}/${BRIDGE_NETMASK} dev ${BRIDGE_NAME}`,
  );

  // Bring bridge up
  await execCommand(`ip link set ${BRIDGE_NAME} up`);

  // Enable IP forwarding
  await execCommand(`sysctl -w net.ipv4.ip_forward=1`);

  // Set up NAT (masquerade outbound traffic from VMs)
  // Check if rule already exists to avoid duplicates
  try {
    await execCommand(
      `iptables -t nat -C POSTROUTING -s ${BRIDGE_CIDR} -j MASQUERADE`,
    );
    console.log("NAT rule already exists");
  } catch {
    // Rule doesn't exist, add it
    await execCommand(
      `iptables -t nat -A POSTROUTING -s ${BRIDGE_CIDR} -j MASQUERADE`,
    );
    console.log("NAT rule added");
  }

  // Set up FORWARD rules for VM traffic
  // Docker sets FORWARD policy to DROP, so we need explicit rules
  await setupForwardRules();

  console.log(`Bridge ${BRIDGE_NAME} configured with IP ${BRIDGE_IP}`);
}

/**
 * Check if a TAP device exists
 */
async function tapDeviceExists(tapDevice: string): Promise<boolean> {
  try {
    await execCommand(`ip link show ${tapDevice}`, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create and configure a TAP device for a VM
 */
export async function createTapDevice(vmId: string): Promise<VMNetworkConfig> {
  // TAP device name limited to 15 chars, use "tap" + first 8 chars of vmId
  const tapDevice = `tap${vmId.substring(0, 8)}`;
  const guestMac = generateMacAddress(vmId);
  const guestIp = generateGuestIp(vmId);

  console.log(`Creating TAP device ${tapDevice} for VM ${vmId}...`);

  // Ensure bridge exists
  await setupBridge();

  // Delete existing TAP device if it exists (from previous runs or failed cleanup)
  if (await tapDeviceExists(tapDevice)) {
    console.log(`TAP device ${tapDevice} already exists, deleting it first...`);
    await deleteTapDevice(tapDevice);
  }

  // Create TAP device
  await execCommand(`ip tuntap add ${tapDevice} mode tap`);

  // Add TAP to bridge
  await execCommand(`ip link set ${tapDevice} master ${BRIDGE_NAME}`);

  // Bring TAP up
  await execCommand(`ip link set ${tapDevice} up`);

  console.log(
    `TAP ${tapDevice} created: guest MAC ${guestMac}, guest IP ${guestIp}`,
  );

  return {
    tapDevice,
    guestMac,
    guestIp,
    gatewayIp: BRIDGE_IP,
    netmask: BRIDGE_NETMASK,
  };
}

/**
 * Delete a TAP device
 */
export async function deleteTapDevice(tapDevice: string): Promise<void> {
  // Only attempt delete if device exists
  if (!(await tapDeviceExists(tapDevice))) {
    console.log(`TAP device ${tapDevice} does not exist, skipping delete`);
    return;
  }
  await execCommand(`ip link delete ${tapDevice}`);
  console.log(`TAP device ${tapDevice} deleted`);
}

/**
 * Generate kernel boot arguments for network configuration
 * These configure the guest's network interface at boot time
 */
export function generateNetworkBootArgs(config: VMNetworkConfig): string {
  // Format: ip=<client-ip>:<server-ip>:<gw-ip>:<netmask>:<hostname>:<device>:<autoconf>
  // We set: ip=guestIp::gatewayIp:netmask:hostname:eth0:off
  return `ip=${config.guestIp}::${config.gatewayIp}:${config.netmask}:vm0-guest:eth0:off`;
}

/**
 * Get the bridge gateway IP
 */
export function getBridgeGatewayIp(): string {
  return BRIDGE_IP;
}

/**
 * Check prerequisites for networking
 */
export function checkNetworkPrerequisites(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for required commands
  const requiredCommands = ["ip", "iptables", "sysctl"];
  for (const cmd of requiredCommands) {
    if (!commandExists(cmd)) {
      errors.push(`Required command not found: ${cmd}`);
    }
  }

  // Check if we have root/sudo access (simplified check)
  try {
    execSync("sudo -n true 2>/dev/null", { stdio: "ignore" });
  } catch {
    errors.push(
      "Root/sudo access required for network configuration. Please run with sudo or configure sudoers.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Set up iptables DNAT rules to redirect a specific VM's traffic to the proxy
 * Only VMs with network security enabled should have their traffic intercepted.
 *
 * @param vmIp The VM's IP address (e.g., "172.16.0.42")
 * @param proxyPort The port mitmproxy is listening on (e.g., 8080)
 */
export async function setupVMProxyRules(
  vmIp: string,
  proxyPort: number,
): Promise<void> {
  console.log(
    `Setting up proxy rules for VM ${vmIp} -> localhost:${proxyPort}`,
  );

  // Redirect HTTP (port 80) from this specific VM to proxy
  try {
    await execCommand(
      `iptables -t nat -C PREROUTING -s ${vmIp} -p tcp --dport 80 -j REDIRECT --to-port ${proxyPort}`,
    );
    console.log(`Proxy rule for ${vmIp}:80 already exists`);
  } catch {
    await execCommand(
      `iptables -t nat -A PREROUTING -s ${vmIp} -p tcp --dport 80 -j REDIRECT --to-port ${proxyPort}`,
    );
    console.log(`Proxy rule for ${vmIp}:80 added`);
  }

  // Redirect HTTPS (port 443) from this specific VM to proxy
  try {
    await execCommand(
      `iptables -t nat -C PREROUTING -s ${vmIp} -p tcp --dport 443 -j REDIRECT --to-port ${proxyPort}`,
    );
    console.log(`Proxy rule for ${vmIp}:443 already exists`);
  } catch {
    await execCommand(
      `iptables -t nat -A PREROUTING -s ${vmIp} -p tcp --dport 443 -j REDIRECT --to-port ${proxyPort}`,
    );
    console.log(`Proxy rule for ${vmIp}:443 added`);
  }

  console.log(`Proxy rules configured for VM ${vmIp}`);
}

/**
 * Remove iptables DNAT rules for a specific VM
 *
 * @param vmIp The VM's IP address
 * @param proxyPort The port mitmproxy is listening on (e.g., 8080)
 */
export async function removeVMProxyRules(
  vmIp: string,
  proxyPort: number,
): Promise<void> {
  console.log(`Removing proxy rules for VM ${vmIp}...`);

  // Remove HTTP rule
  try {
    await execCommand(
      `iptables -t nat -D PREROUTING -s ${vmIp} -p tcp --dport 80 -j REDIRECT --to-port ${proxyPort}`,
    );
    console.log(`Proxy rule for ${vmIp}:80 removed`);
  } catch {
    // Rule doesn't exist, that's fine
  }

  // Remove HTTPS rule
  try {
    await execCommand(
      `iptables -t nat -D PREROUTING -s ${vmIp} -p tcp --dport 443 -j REDIRECT --to-port ${proxyPort}`,
    );
    console.log(`Proxy rule for ${vmIp}:443 removed`);
  } catch {
    // Rule doesn't exist, that's fine
  }

  console.log(`Proxy rules cleanup complete for VM ${vmIp}`);
}

/**
 * List all TAP devices that match our naming pattern (tap + 8 hex chars)
 */
export async function listTapDevices(): Promise<string[]> {
  try {
    const result = await execCommand("ip -o link show type tuntap", false);
    const devices: string[] = [];

    const lines = result.split("\n");
    for (const line of lines) {
      const match = line.match(/^\d+:\s+(tap[a-f0-9]{8}):/);
      if (match && match[1]) {
        devices.push(match[1]);
      }
    }

    return devices;
  } catch {
    return [];
  }
}

/**
 * Check if the network bridge exists and is up
 */
export async function checkBridgeStatus(): Promise<{
  exists: boolean;
  ip?: string;
  up?: boolean;
}> {
  try {
    const result = await execCommand(`ip -o addr show ${BRIDGE_NAME}`, false);
    // Output: "3: vm0br0    inet 172.16.0.1/24 ..."
    const ipMatch = result.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    const upMatch = result.includes("UP") || result.includes("state UP");

    return {
      exists: true,
      ip: ipMatch?.[1] ?? BRIDGE_IP,
      up: upMatch,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Check if a port is in use (for proxy check)
 */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    await execCommand(`ss -tln | grep -q ":${port} "`, false);
    return true;
  } catch {
    return false;
  }
}

/**
 * iptables NAT rule targeting VM subnet
 */
export interface IptablesRule {
  sourceIp: string;
  destPort: number;
  redirectPort: number;
}

/**
 * Scan iptables NAT PREROUTING rules for VM-related redirects
 * Returns rules that redirect traffic from VM subnet (172.16.0.0/24)
 */
export async function listIptablesNatRules(): Promise<IptablesRule[]> {
  try {
    // Get PREROUTING rules in numeric format
    const result = await execCommand("iptables -t nat -L PREROUTING -n", true);
    const rules: IptablesRule[] = [];

    // Parse output lines like:
    // REDIRECT   tcp  --  172.16.0.98   0.0.0.0/0   tcp dpt:80  redir ports 8270
    const lines = result.split("\n");
    for (const line of lines) {
      // Match REDIRECT rules from VM subnet
      const match = line.match(
        /REDIRECT\s+tcp\s+--\s+(172\.16\.0\.\d+)\s+\S+\s+tcp\s+dpt:(\d+)\s+redir\s+ports\s+(\d+)/,
      );
      if (match && match[1] && match[2] && match[3]) {
        rules.push({
          sourceIp: match[1],
          destPort: parseInt(match[2], 10),
          redirectPort: parseInt(match[3], 10),
        });
      }
    }

    return rules;
  } catch {
    return [];
  }
}

/**
 * Check which iptables rules are orphaned (redirect to ports with no service)
 */
export async function findOrphanedIptablesRules(
  rules: IptablesRule[],
  activeVmIps: Set<string>,
  expectedProxyPort: number,
): Promise<IptablesRule[]> {
  const orphaned: IptablesRule[] = [];

  for (const rule of rules) {
    // Rule is orphaned if:
    // 1. Source IP is not an active VM, OR
    // 2. Redirect port doesn't match expected proxy port
    const isActiveVm = activeVmIps.has(rule.sourceIp);
    const correctPort = rule.redirectPort === expectedProxyPort;

    if (!isActiveVm || !correctPort) {
      // Double-check: is the redirect port actually listening?
      const portListening = await isPortInUse(rule.redirectPort);
      if (!portListening) {
        orphaned.push(rule);
      }
    }
  }

  return orphaned;
}
