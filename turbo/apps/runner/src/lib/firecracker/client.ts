/**
 * Firecracker API Client
 *
 * Communicates with Firecracker via HTTP over Unix socket.
 * See: https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests.md
 */

import http from "node:http";

/**
 * Machine configuration for Firecracker VM
 */
interface MachineConfig {
  vcpu_count: number;
  mem_size_mib: number;
  smt?: boolean; // Simultaneous Multi-Threading (default: false)
}

/**
 * Boot source configuration
 */
interface BootSource {
  kernel_image_path: string;
  boot_args?: string;
}

/**
 * Drive configuration for block devices
 */
interface Drive {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
}

/**
 * Network interface configuration
 */
interface NetworkInterface {
  iface_id: string;
  guest_mac?: string;
  host_dev_name: string;
}

/**
 * Vsock device configuration
 */
interface Vsock {
  vsock_id: string;
  guest_cid: number;
  uds_path: string;
}

/**
 * Action types for VM control
 */
type ActionType = "InstanceStart" | "SendCtrlAltDel" | "FlushMetrics";

/**
 * Firecracker API Client
 * Manages communication with Firecracker process via Unix socket
 */
export class FirecrackerClient {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Make HTTP request to Firecracker API
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Serialize body first to calculate Content-Length
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

      const headers: http.OutgoingHttpHeaders = {
        Accept: "application/json",
        Connection: "close", // Disable keep-alive to prevent request pipelining issues
      };

      // Set Content-Type and Content-Length for requests with body
      if (bodyStr !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      // Debug log
      console.log(
        `[FC API] ${method} ${path}${bodyStr ? ` (${Buffer.byteLength(bodyStr)} bytes)` : ""}`,
      );

      const options: http.RequestOptions = {
        socketPath: this.socketPath,
        path,
        method,
        headers,
        // Disable agent to ensure fresh connection for each request
        // Firecracker's single-threaded API can have issues with pipelined requests
        agent: false,
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            // Success - parse response if present
            if (data) {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
            } else {
              resolve(undefined);
            }
          } else {
            // Error response
            let errorMsg = `Firecracker API error: ${res.statusCode}`;
            if (data) {
              try {
                const errorBody = JSON.parse(data) as {
                  fault_message?: string;
                };
                if (errorBody.fault_message) {
                  errorMsg = `${errorMsg} - ${errorBody.fault_message}`;
                }
              } catch {
                errorMsg = `${errorMsg} - ${data}`;
              }
            }
            reject(new Error(errorMsg));
          }
        });
      });

      req.on("error", (err: Error) => {
        reject(new Error(`Failed to connect to Firecracker: ${err.message}`));
      });

      if (bodyStr !== undefined) {
        req.write(bodyStr);
      }

      req.end();
    });
  }

  /**
   * Configure machine settings (vCPUs, memory)
   */
  async setMachineConfig(config: MachineConfig): Promise<void> {
    await this.request("PUT", "/machine-config", config);
  }

  /**
   * Configure boot source (kernel)
   */
  async setBootSource(config: BootSource): Promise<void> {
    await this.request("PUT", "/boot-source", config);
  }

  /**
   * Add or update a drive (block device)
   */
  async setDrive(drive: Drive): Promise<void> {
    await this.request("PUT", `/drives/${drive.drive_id}`, drive);
  }

  /**
   * Add or update a network interface
   */
  async setNetworkInterface(iface: NetworkInterface): Promise<void> {
    await this.request("PUT", `/network-interfaces/${iface.iface_id}`, iface);
  }

  /**
   * Configure vsock device for host-guest communication
   */
  async setVsock(vsock: Vsock): Promise<void> {
    await this.request("PUT", "/vsock", vsock);
  }

  /**
   * Perform an action (start, stop, etc.)
   */
  async performAction(actionType: ActionType): Promise<void> {
    await this.request("PUT", "/actions", { action_type: actionType });
  }

  /**
   * Start the VM instance
   */
  async start(): Promise<void> {
    await this.performAction("InstanceStart");
  }

  /**
   * Send Ctrl+Alt+Del to the VM (graceful shutdown request)
   */
  async sendCtrlAltDel(): Promise<void> {
    await this.performAction("SendCtrlAltDel");
  }

  /**
   * Get machine configuration
   */
  async getMachineConfig(): Promise<MachineConfig> {
    return (await this.request("GET", "/machine-config")) as MachineConfig;
  }

  /**
   * Check if the Firecracker API is ready
   * Returns true if API is responding
   */
  async isReady(): Promise<boolean> {
    try {
      await this.request("GET", "/");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for Firecracker API to become ready
   * @param timeoutMs Maximum time to wait
   * @param intervalMs Polling interval
   */
  async waitUntilReady(
    timeoutMs: number = 5000,
    intervalMs: number = 100,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isReady()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Firecracker API not ready after ${timeoutMs}ms at ${this.socketPath}`,
    );
  }
}
