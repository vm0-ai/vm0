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
import { createLogger } from "../logger.js";

const logger = createLogger("ProxyManager");

/**
 * Required proxy configuration (must be provided)
 */
interface RequiredProxyConfig {
  /** Path to the mitmproxy CA directory (per-runner isolation) */
  caDir: string;
}

/**
 * Optional proxy configuration (has defaults)
 */
interface OptionalProxyConfig {
  /** Port for mitmproxy to listen on */
  port: number;
  /** Path to the VM registry file */
  registryPath: string;
  /** VM0 API URL for the addon */
  apiUrl: string;
}

/**
 * Full proxy configuration (internal use)
 */
interface ProxyConfig extends RequiredProxyConfig, OptionalProxyConfig {
  /** Path to the mitm_addon.py script (derived from caDir) */
  addonPath: string;
}

/**
 * Input configuration for ProxyManager
 */
type ProxyConfigInput = RequiredProxyConfig & Partial<OptionalProxyConfig>;

/**
 * Default values for optional proxy configuration
 */
const DEFAULT_PROXY_OPTIONS: OptionalProxyConfig = {
  port: 8080,
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

  constructor(config: ProxyConfigInput) {
    // Derive addonPath from caDir
    const addonPath = path.join(config.caDir, "mitm_addon.py");
    this.config = {
      ...DEFAULT_PROXY_OPTIONS,
      ...config,
      addonPath,
    };
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
    logger.log(`Addon script written to ${this.config.addonPath}`);
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
      logger.log("Proxy already running");
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

    logger.log("Starting mitmproxy...");
    logger.log(`  Port: ${this.config.port}`);
    logger.log(`  CA Dir: ${this.config.caDir}`);
    logger.log(`  Addon: ${this.config.addonPath}`);
    logger.log(`  Registry: ${this.config.registryPath}`);

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

    // Log stdout/stderr (use mitmproxy prefix for process output)
    const mitmLogger = createLogger("mitmproxy");
    this.process.stdout?.on("data", (data: Buffer) => {
      mitmLogger.log(data.toString().trim());
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      mitmLogger.log(data.toString().trim());
    });

    this.process.on("close", (code) => {
      logger.log(`mitmproxy exited with code ${code}`);
      this.isRunning = false;
      this.process = null;
    });

    this.process.on("error", (err) => {
      logger.error(`mitmproxy error: ${err.message}`);
      this.isRunning = false;
      this.process = null;
    });

    // Wait for proxy to start
    await this.waitForReady();

    this.isRunning = true;
    logger.log("mitmproxy started successfully");

    // Register exit handler to ensure proxy is killed when runner exits
    // This handles cases where pm2 delete doesn't give runner time to cleanup
    process.on("exit", () => {
      if (this.process && !this.process.killed) {
        this.process.kill("SIGKILL");
      }
    });
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
      logger.log("Proxy not running");
      return;
    }

    logger.log("Stopping mitmproxy...");

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        logger.log("Force killing mitmproxy...");
        this.process?.kill("SIGKILL");
      }, 5000);

      this.process.on("close", () => {
        clearTimeout(timeout);
        this.isRunning = false;
        this.process = null;
        logger.log("mitmproxy stopped");
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
 * @throws Error if proxy manager was not initialized with initProxyManager
 */
export function getProxyManager(): ProxyManager {
  if (!globalProxyManager) {
    throw new Error(
      "ProxyManager not initialized. Call initProxyManager() first with caDir.",
    );
  }
  return globalProxyManager;
}

/**
 * Initialize the proxy manager with config
 * @param config - Configuration including required caDir
 */
export function initProxyManager(config: ProxyConfigInput): ProxyManager {
  globalProxyManager = new ProxyManager(config);
  return globalProxyManager;
}
