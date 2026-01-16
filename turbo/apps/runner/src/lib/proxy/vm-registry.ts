/**
 * VM Registry for tracking VM IP → RunId mappings
 *
 * This module maintains a mapping between VM IP addresses and their associated
 * run metadata. The mitmproxy addon uses this to identify which run a request
 * belongs to based on the source IP address.
 *
 * The registry is stored as a JSON file that the mitmproxy addon can read.
 */
import fs from "fs";

/**
 * Firewall rule for VM network egress control
 *
 * Rules can be either:
 * - Domain/IP rule: { domain: "*.example.com", action: "ALLOW" }
 * - Terminal rule: { final: "DENY" } - value is the action
 */
interface FirewallRule {
  domain?: string;
  ip?: string;
  /** Terminal rule - value is the action (ALLOW or DENY) */
  final?: "ALLOW" | "DENY";
  /** Action for domain/ip rules */
  action?: "ALLOW" | "DENY";
}

/**
 * VM registration data
 */
interface VMRegistration {
  runId: string;
  sandboxToken: string;
  registeredAt: number;
  /** Firewall rules for network filtering (first-match-wins) */
  firewallRules?: FirewallRule[];
  /** Enable HTTPS inspection via MITM */
  mitmEnabled?: boolean;
  /** Encrypt secrets (requires MITM) */
  sealSecretsEnabled?: boolean;
}

/**
 * Registry file format
 */
interface RegistryData {
  vms: Record<string, VMRegistration>;
  updatedAt: number;
}

/**
 * Default path for the registry file
 * This path is read by the mitmproxy addon
 */
export const DEFAULT_REGISTRY_PATH = "/tmp/vm0-vm-registry.json";

/**
 * VM Registry class for managing VM IP → RunId mappings
 */
export class VMRegistry {
  private registryPath: string;
  private data: RegistryData;

  constructor(registryPath: string = DEFAULT_REGISTRY_PATH) {
    this.registryPath = registryPath;
    this.data = this.load();
  }

  /**
   * Load registry data from file
   */
  private load(): RegistryData {
    try {
      if (fs.existsSync(this.registryPath)) {
        const content = fs.readFileSync(this.registryPath, "utf-8");
        return JSON.parse(content) as RegistryData;
      }
    } catch {
      // File doesn't exist or is corrupted, start fresh
    }
    return { vms: {}, updatedAt: Date.now() };
  }

  /**
   * Save registry data to file atomically
   */
  private save(): void {
    this.data.updatedAt = Date.now();
    const content = JSON.stringify(this.data, null, 2);

    // Write atomically by writing to temp file then renaming
    const tempPath = `${this.registryPath}.tmp`;
    fs.writeFileSync(tempPath, content, { mode: 0o644 });
    fs.renameSync(tempPath, this.registryPath);
  }

  /**
   * Register a VM with its IP address
   */
  register(
    vmIp: string,
    runId: string,
    sandboxToken: string,
    options?: {
      firewallRules?: FirewallRule[];
      mitmEnabled?: boolean;
      sealSecretsEnabled?: boolean;
    },
  ): void {
    this.data.vms[vmIp] = {
      runId,
      sandboxToken,
      registeredAt: Date.now(),
      firewallRules: options?.firewallRules,
      mitmEnabled: options?.mitmEnabled,
      sealSecretsEnabled: options?.sealSecretsEnabled,
    };
    this.save();
    const firewallInfo = options?.firewallRules
      ? ` with ${options.firewallRules.length} firewall rules`
      : "";
    const mitmInfo = options?.mitmEnabled ? ", MITM enabled" : "";
    console.log(
      `[VMRegistry] Registered VM ${vmIp} for run ${runId}${firewallInfo}${mitmInfo}`,
    );
  }

  /**
   * Unregister a VM by IP address
   */
  unregister(vmIp: string): void {
    if (this.data.vms[vmIp]) {
      const registration = this.data.vms[vmIp];
      delete this.data.vms[vmIp];
      this.save();
      console.log(
        `[VMRegistry] Unregistered VM ${vmIp} (run ${registration.runId})`,
      );
    }
  }

  /**
   * Look up registration by VM IP
   */
  lookup(vmIp: string): VMRegistration | undefined {
    return this.data.vms[vmIp];
  }

  /**
   * Get all registered VMs
   */
  getAll(): Record<string, VMRegistration> {
    return { ...this.data.vms };
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.data.vms = {};
    this.save();
    console.log("[VMRegistry] Cleared all registrations");
  }

  /**
   * Get the path to the registry file
   */
  getRegistryPath(): string {
    return this.registryPath;
  }
}

// Singleton instance for global access
let globalRegistry: VMRegistry | null = null;

/**
 * Get the global VM registry instance
 */
export function getVMRegistry(): VMRegistry {
  if (!globalRegistry) {
    globalRegistry = new VMRegistry();
  }
  return globalRegistry;
}

/**
 * Initialize the VM registry with a custom path
 */
export function initVMRegistry(registryPath?: string): VMRegistry {
  globalRegistry = new VMRegistry(registryPath);
  return globalRegistry;
}
