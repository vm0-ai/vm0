/**
 * Proxy Manager for mitmproxy lifecycle management
 *
 * This module manages the mitmproxy process on the runner host:
 * - Starting mitmproxy with the VM0 addon
 * - Health checking the proxy
 * - Stopping the proxy on shutdown
 */
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { getVMRegistry, DEFAULT_REGISTRY_PATH } from "./vm-registry";
import { RUNNER_MITM_ADDON_SCRIPT } from "./mitm-addon-script";

/**
 * Proxy configuration
 */
interface ProxyConfig {
  /** Port for mitmproxy to listen on */
  port: number;
  /** Path to the mitmproxy CA directory */
  caDir: string;
  /** Path to the mitm_addon.py script */
  addonPath: string;
  /** Path to the VM registry file */
  registryPath: string;
  /** VM0 API URL for the addon */
  apiUrl: string;
}

/**
 * Default proxy configuration
 */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 8080,
  caDir: "/opt/vm0-runner/proxy",
  addonPath: "/opt/vm0-runner/proxy/mitm_addon.py",
  registryPath: DEFAULT_REGISTRY_PATH,
  apiUrl: process.env.VM0_API_URL || "https://www.vm0.ai",
};

/**
 * Proxy Manager class
 */
export class ProxyManager {
  private config: ProxyConfig;
  private process: ChildProcess | null = null;
  private isRunning: boolean = false;

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = { ...DEFAULT_PROXY_CONFIG, ...config };
  }

  /**
   * Check if mitmproxy is available
   */
  async checkMitmproxyInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("mitmdump", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Ensure the addon script exists at the configured path
   */
  ensureAddonScript(): void {
    const addonDir = path.dirname(this.config.addonPath);

    // Create directory if needed
    if (!fs.existsSync(addonDir)) {
      fs.mkdirSync(addonDir, { recursive: true });
    }

    // Write addon script
    fs.writeFileSync(this.config.addonPath, RUNNER_MITM_ADDON_SCRIPT, {
      mode: 0o755,
    });
    console.log(
      `[ProxyManager] Addon script written to ${this.config.addonPath}`,
    );
  }

  /**
   * Validate proxy configuration
   */
  validateConfig(): void {
    // Check CA directory exists
    if (!fs.existsSync(this.config.caDir)) {
      throw new Error(`Proxy CA directory not found: ${this.config.caDir}`);
    }

    // Check CA certificate exists
    const caCertPath = path.join(this.config.caDir, "mitmproxy-ca.pem");
    if (!fs.existsSync(caCertPath)) {
      throw new Error(`Proxy CA certificate not found: ${caCertPath}`);
    }

    // Ensure addon script exists (write it if not)
    this.ensureAddonScript();
  }

  /**
   * Start mitmproxy
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("[ProxyManager] Proxy already running");
      return;
    }

    // Check mitmproxy is installed
    const mitmproxyInstalled = await this.checkMitmproxyInstalled();
    if (!mitmproxyInstalled) {
      throw new Error(
        "mitmproxy not installed. Install with: pip install mitmproxy",
      );
    }

    // Validate configuration
    this.validateConfig();

    // Initialize VM registry to create the file
    getVMRegistry();

    console.log("[ProxyManager] Starting mitmproxy...");
    console.log(`  Port: ${this.config.port}`);
    console.log(`  CA Dir: ${this.config.caDir}`);
    console.log(`  Addon: ${this.config.addonPath}`);
    console.log(`  Registry: ${this.config.registryPath}`);

    // Start mitmproxy in transparent mode
    const args = [
      "--mode",
      "transparent",
      "--listen-port",
      String(this.config.port),
      "--set",
      `confdir=${this.config.caDir}`,
      "--scripts",
      this.config.addonPath,
      "--quiet",
    ];

    // Set environment variables for the addon
    const env = {
      ...process.env,
      VM0_API_URL: this.config.apiUrl,
      VM0_REGISTRY_PATH: this.config.registryPath,
    };

    this.process = spawn("mitmdump", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Log stdout/stderr
    this.process.stdout?.on("data", (data: Buffer) => {
      console.log(`[mitmproxy] ${data.toString().trim()}`);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      console.error(`[mitmproxy] ${data.toString().trim()}`);
    });

    this.process.on("close", (code) => {
      console.log(`[ProxyManager] mitmproxy exited with code ${code}`);
      this.isRunning = false;
      this.process = null;
    });

    this.process.on("error", (err) => {
      console.error(`[ProxyManager] mitmproxy error: ${err.message}`);
      this.isRunning = false;
      this.process = null;
    });

    // Wait for proxy to start
    await this.waitForReady();

    this.isRunning = true;
    console.log("[ProxyManager] mitmproxy started successfully");
  }

  /**
   * Wait for proxy to be ready
   */
  private async waitForReady(timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      // Check if process is still running
      if (this.process && this.process.exitCode !== null) {
        throw new Error(
          `mitmproxy exited unexpectedly with code ${this.process.exitCode}`,
        );
      }

      // Simple check: if process is still alive after a short delay, assume it's ready
      // mitmproxy doesn't have a built-in health check endpoint
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      if (this.process && this.process.exitCode === null) {
        return;
      }
    }

    throw new Error("Timeout waiting for mitmproxy to start");
  }

  /**
   * Stop mitmproxy
   */
  async stop(): Promise<void> {
    if (!this.process || !this.isRunning) {
      console.log("[ProxyManager] Proxy not running");
      return;
    }

    console.log("[ProxyManager] Stopping mitmproxy...");

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        console.log("[ProxyManager] Force killing mitmproxy...");
        this.process?.kill("SIGKILL");
      }, 5000);

      this.process.on("close", () => {
        clearTimeout(timeout);
        this.isRunning = false;
        this.process = null;
        console.log("[ProxyManager] mitmproxy stopped");
        resolve();
      });

      this.process.kill("SIGTERM");
    });
  }

  /**
   * Check if proxy is running
   */
  isProxyRunning(): boolean {
    return this.isRunning && this.process !== null;
  }

  /**
   * Get proxy configuration
   */
  getConfig(): ProxyConfig {
    return { ...this.config };
  }
}

// Singleton instance for global access
let globalProxyManager: ProxyManager | null = null;

/**
 * Get the global proxy manager instance
 */
export function getProxyManager(): ProxyManager {
  if (!globalProxyManager) {
    globalProxyManager = new ProxyManager();
  }
  return globalProxyManager;
}

/**
 * Initialize the proxy manager with custom config
 */
export function initProxyManager(config?: Partial<ProxyConfig>): ProxyManager {
  globalProxyManager = new ProxyManager(config);
  return globalProxyManager;
}
