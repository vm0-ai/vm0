/**
 * Firecracker HTTP API Client
 *
 * Communicates with Firecracker via HTTP over Unix Domain Socket.
 * Only implements APIs needed for snapshot support.
 *
 * API Reference: https://github.com/firecracker-microvm/firecracker/blob/main/src/api_server/swagger/firecracker.yaml
 */

import * as http from "node:http";
import * as fs from "node:fs";
import { createLogger } from "../logger.js";

const logger = createLogger("FirecrackerClient");

/**
 * Snapshot creation configuration
 */
export interface SnapshotCreateConfig {
  /** Full or Diff snapshot */
  snapshot_type: "Full" | "Diff";
  /** Path to save the snapshot state file */
  snapshot_path: string;
  /** Path to save the memory file */
  mem_file_path: string;
}

/**
 * Memory backend configuration for snapshot loading
 */
export interface MemBackendConfig {
  /** Path to the memory file */
  backend_path: string;
  /** Backend type: File (kernel handles page faults) or Uffd (userspace) */
  backend_type: "File" | "Uffd";
}

/**
 * Network interface override for snapshot loading
 * Used to change the host TAP device name when restoring
 */
export interface NetworkOverride {
  /** Interface ID (e.g., "eth0") */
  iface_id: string;
  /** New host TAP device name */
  host_dev_name: string;
}

/**
 * Snapshot loading configuration
 */
export interface SnapshotLoadConfig {
  /** Path to the snapshot state file */
  snapshot_path: string;
  /** Memory backend configuration */
  mem_backend: MemBackendConfig;
  /** Whether to resume VM after loading (default: false) */
  resume_vm?: boolean;
  /** Optional network interface overrides */
  network_overrides?: NetworkOverride[];
}

/**
 * Drive configuration for snapshot restoration
 * Must be configured before loading snapshot if paths differ from original
 */
export interface DriveConfig {
  /** Drive identifier (e.g., "rootfs", "overlay") */
  drive_id: string;
  /** Path to the drive file on host */
  path_on_host: string;
  /** Whether this is the root device */
  is_root_device: boolean;
  /** Whether the drive is read-only */
  is_read_only: boolean;
}

/**
 * Machine configuration
 */
export interface MachineConfig {
  vcpu_count: number;
  mem_size_mib: number;
  track_dirty_pages?: boolean;
}

/**
 * Boot source configuration
 */
export interface BootSourceConfig {
  kernel_image_path: string;
  boot_args?: string;
}

/**
 * Network interface configuration
 */
export interface NetworkInterfaceConfig {
  iface_id: string;
  guest_mac?: string;
  host_dev_name: string;
}

/**
 * Vsock device configuration
 */
export interface VsockConfig {
  guest_cid: number;
  uds_path: string;
}

/**
 * API error response from Firecracker
 */
export interface ApiError {
  fault_message: string;
}

/**
 * Firecracker API Client Error
 */
export class FirecrackerApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly path: string,
    public readonly faultMessage: string,
  ) {
    super(`Firecracker API error ${statusCode} on ${path}: ${faultMessage}`);
    this.name = "FirecrackerApiError";
  }
}

/**
 * Firecracker HTTP API Client
 *
 * Implements APIs needed for VM configuration and snapshot support:
 * - VM configuration (machine, boot-source, drives, network, vsock)
 * - VM lifecycle (start, pause, resume)
 * - Snapshots (create, load)
 */
export class FirecrackerClient {
  constructor(private readonly socketPath: string) {}

  /**
   * Configure machine settings (vCPUs, memory)
   */
  async configureMachine(config: MachineConfig): Promise<void> {
    await this.put("/machine-config", config);
  }

  /**
   * Configure boot source (kernel, boot args)
   */
  async configureBootSource(config: BootSourceConfig): Promise<void> {
    await this.put("/boot-source", config);
  }

  /**
   * Configure network interface
   */
  async configureNetworkInterface(
    config: NetworkInterfaceConfig,
  ): Promise<void> {
    await this.put(`/network-interfaces/${config.iface_id}`, config);
  }

  /**
   * Configure vsock device
   */
  async configureVsock(config: VsockConfig): Promise<void> {
    await this.put("/vsock", config);
  }

  /**
   * Start the VM instance
   */
  async startInstance(): Promise<void> {
    await this.put("/actions", { action_type: "InstanceStart" });
  }

  /**
   * Pause the VM
   *
   * Must be called before creating a snapshot.
   */
  async pause(): Promise<void> {
    await this.patch("/vm", { state: "Paused" });
  }

  /**
   * Resume the VM
   *
   * Can be called after loading a snapshot with resume_vm: false,
   * or to resume a paused VM.
   */
  async resume(): Promise<void> {
    await this.patch("/vm", { state: "Resumed" });
  }

  /**
   * Create a snapshot
   *
   * The VM must be paused before calling this.
   * Creates two files: snapshot state and memory.
   */
  async createSnapshot(config: SnapshotCreateConfig): Promise<void> {
    await this.put("/snapshot/create", config);
  }

  /**
   * Load a snapshot
   *
   * Must be called before any VM configuration is done.
   * Only logger and metrics can be configured before loading.
   */
  async loadSnapshot(config: SnapshotLoadConfig): Promise<void> {
    await this.put("/snapshot/load", config);
  }

  /**
   * Configure a drive
   *
   * Used before loading snapshot to update drive paths.
   * When restoring from snapshot, if drive paths differ from original,
   * they must be configured before calling loadSnapshot.
   */
  async configureDrive(config: DriveConfig): Promise<void> {
    await this.put(`/drives/${config.drive_id}`, config);
  }

  /**
   * Wait for the API socket to become ready
   *
   * Polls until the socket exists and responds to requests.
   *
   * @param timeoutMs Maximum time to wait (default: 5000ms)
   * @param intervalMs Polling interval (default: 100ms)
   */
  async waitForReady(
    timeoutMs: number = 5000,
    intervalMs: number = 100,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // First check if socket file exists
      if (!fs.existsSync(this.socketPath)) {
        await this.sleep(intervalMs);
        continue;
      }

      // Try to make a request
      try {
        await this.get("/");
        return;
      } catch {
        // Socket exists but not ready yet, or request failed
        await this.sleep(intervalMs);
      }
    }

    throw new Error(
      `Firecracker API not ready after ${timeoutMs}ms (socket: ${this.socketPath})`,
    );
  }

  /**
   * GET request
   */
  private async get(path: string): Promise<string> {
    return this.request("GET", path);
  }

  /**
   * PATCH request
   */
  private async patch(path: string, body: unknown): Promise<string> {
    return this.request("PATCH", path, body);
  }

  /**
   * PUT request
   */
  private async put(path: string, body: unknown): Promise<string> {
    return this.request("PUT", path, body);
  }

  /**
   * Make an HTTP request to Firecracker API
   *
   * @param timeoutMs Request timeout in milliseconds (default: 30000ms)
   */
  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = 30000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Serialize body first to calculate Content-Length
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

      const headers: http.OutgoingHttpHeaders = {
        Accept: "application/json",
        // Disable keep-alive to prevent pipelining issues
        Connection: "close",
      };

      // Set Content-Type and Content-Length only for requests with body
      if (bodyStr !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const options: http.RequestOptions = {
        socketPath: this.socketPath,
        path,
        method,
        headers,
        timeout: timeoutMs,
        // Disable agent to ensure fresh connection for each request
        // Firecracker's single-threaded API can have issues with pipelined requests
        agent: false,
      };

      logger.log(`${method} ${path}${bodyStr ? " " + bodyStr : ""}`);

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;

          if (statusCode >= 200 && statusCode < 300) {
            resolve(data);
          } else {
            // Try to parse error message
            let faultMessage = data;
            try {
              const errorBody = JSON.parse(data) as ApiError;
              faultMessage = errorBody.fault_message || data;
            } catch {
              // Use raw data as message
            }
            reject(new FirecrackerApiError(statusCode, path, faultMessage));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(
          new Error(`Request timeout after ${timeoutMs}ms: ${method} ${path}`),
        );
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (bodyStr !== undefined) {
        req.write(bodyStr);
      }

      req.end();
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
