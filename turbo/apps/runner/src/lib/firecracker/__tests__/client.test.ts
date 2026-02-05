import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FirecrackerClient, FirecrackerApiError } from "../client.js";

describe("FirecrackerClient", () => {
  let testDir: string;
  let socketPath: string;
  let mockServer: http.Server;
  let requestLog: { method: string; path: string; body: unknown }[] = [];

  /**
   * Create a mock HTTP server listening on Unix socket
   */
  function createMockServer(
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => void | Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      mockServer = http.createServer((req, res) => {
        const result = handler(req, res);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            // Log but don't crash the server on handler errors
            console.error("Handler error:", err);
          });
        }
      });
      mockServer.on("error", reject);
      mockServer.listen(socketPath, () => {
        resolve();
      });
    });
  }

  /**
   * Stop mock server
   */
  function stopMockServer(): Promise<void> {
    return new Promise((resolve) => {
      if (mockServer) {
        mockServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Parse JSON body from request
   */
  function parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: string) => (data += chunk));
      req.on("end", () => {
        if (data) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        } else {
          resolve(undefined);
        }
      });
      req.on("error", reject);
    });
  }

  beforeEach(() => {
    requestLog = [];
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-client-test-"));
    socketPath = path.join(testDir, "firecracker.sock");
  });

  afterEach(async () => {
    await stopMockServer();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("pause", () => {
    it("should send PATCH /vm with Paused state", async () => {
      await createMockServer(async (req, res) => {
        const body = await parseBody(req);
        requestLog.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
        });
        res.writeHead(204);
        res.end();
      });

      const client = new FirecrackerClient(socketPath);
      await client.pause();

      expect(requestLog).toHaveLength(1);
      const log = requestLog[0];
      expect(log).toBeDefined();
      expect(log?.method).toBe("PATCH");
      expect(log?.body).toEqual({ state: "Paused" });
      // URL includes http://localhost prefix when using Unix socket
      expect(log?.path).toContain("/vm");
    });

    it("should throw FirecrackerApiError on failure", async () => {
      await createMockServer(async (req, res) => {
        await parseBody(req);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ fault_message: "VM is not running" }));
      });

      const client = new FirecrackerClient(socketPath);
      await expect(client.pause()).rejects.toThrow(FirecrackerApiError);
      await expect(client.pause()).rejects.toThrow("VM is not running");
    });
  });

  describe("resume", () => {
    it("should send PATCH /vm with Resumed state", async () => {
      await createMockServer(async (req, res) => {
        const body = await parseBody(req);
        requestLog.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
        });
        res.writeHead(204);
        res.end();
      });

      const client = new FirecrackerClient(socketPath);
      await client.resume();

      expect(requestLog).toHaveLength(1);
      const log = requestLog[0];
      expect(log).toBeDefined();
      expect(log?.method).toBe("PATCH");
      expect(log?.body).toEqual({ state: "Resumed" });
      expect(log?.path).toContain("/vm");
    });
  });

  describe("createSnapshot", () => {
    it("should send PUT /snapshot/create with config", async () => {
      await createMockServer(async (req, res) => {
        const body = await parseBody(req);
        requestLog.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
        });
        res.writeHead(204);
        res.end();
      });

      const client = new FirecrackerClient(socketPath);
      await client.createSnapshot({
        snapshot_type: "Full",
        snapshot_path: "/tmp/snapshot.bin",
        mem_file_path: "/tmp/mem.bin",
      });

      expect(requestLog).toHaveLength(1);
      const log = requestLog[0];
      expect(log).toBeDefined();
      expect(log?.method).toBe("PUT");
      expect(log?.body).toEqual({
        snapshot_type: "Full",
        snapshot_path: "/tmp/snapshot.bin",
        mem_file_path: "/tmp/mem.bin",
      });
      expect(log?.path).toContain("/snapshot/create");
    });
  });

  describe("loadSnapshot", () => {
    it("should send PUT /snapshot/load with config", async () => {
      await createMockServer(async (req, res) => {
        const body = await parseBody(req);
        requestLog.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
        });
        res.writeHead(204);
        res.end();
      });

      const client = new FirecrackerClient(socketPath);
      await client.loadSnapshot({
        snapshot_path: "/tmp/snapshot.bin",
        mem_backend: {
          backend_path: "/tmp/mem.bin",
          backend_type: "File",
        },
        resume_vm: true,
      });

      expect(requestLog).toHaveLength(1);
      const log = requestLog[0];
      expect(log).toBeDefined();
      expect(log?.method).toBe("PUT");
      expect(log?.body).toEqual({
        snapshot_path: "/tmp/snapshot.bin",
        mem_backend: {
          backend_path: "/tmp/mem.bin",
          backend_type: "File",
        },
        resume_vm: true,
      });
      expect(log?.path).toContain("/snapshot/load");
    });

    it("should include network_overrides when provided", async () => {
      await createMockServer(async (req, res) => {
        const body = await parseBody(req);
        requestLog.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
        });
        res.writeHead(204);
        res.end();
      });

      const client = new FirecrackerClient(socketPath);
      await client.loadSnapshot({
        snapshot_path: "/tmp/snapshot.bin",
        mem_backend: {
          backend_path: "/tmp/mem.bin",
          backend_type: "File",
        },
        network_overrides: [{ iface_id: "eth0", host_dev_name: "vmtap1" }],
      });

      expect(requestLog).toHaveLength(1);
      const log = requestLog[0];
      expect(log).toBeDefined();
      const body = log?.body as { network_overrides?: unknown[] } | undefined;
      expect(body?.network_overrides).toEqual([
        { iface_id: "eth0", host_dev_name: "vmtap1" },
      ]);
    });
  });

  describe("waitForReady", () => {
    it("should return immediately when API is ready", async () => {
      await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });

      const client = new FirecrackerClient(socketPath);
      const start = Date.now();
      await client.waitForReady(5000, 50);
      const elapsed = Date.now() - start;

      // Should complete quickly without waiting full timeout
      expect(elapsed).toBeLessThan(1000);
    });

    it("should wait for socket to exist", async () => {
      const client = new FirecrackerClient(socketPath);

      // Start waiting before server exists
      const waitPromise = client.waitForReady(5000, 50);

      // Create server after 200ms
      setTimeout(() => {
        createMockServer((_req, res) => {
          res.writeHead(200);
          res.end("{}");
        }).catch((err: unknown) => {
          console.error("Server creation failed:", err);
        });
      }, 200);

      const start = Date.now();
      await waitPromise;
      const elapsed = Date.now() - start;

      // Should wait at least 200ms for server
      expect(elapsed).toBeGreaterThanOrEqual(150);
    });

    it("should throw after timeout when socket file not created", async () => {
      // No server created - socket doesn't exist
      const client = new FirecrackerClient(socketPath);

      await expect(client.waitForReady(200, 50)).rejects.toThrow(
        "Socket file not created after",
      );
    });
  });

  describe("error handling", () => {
    it("should include status code and path in error", async () => {
      await createMockServer(async (req, res) => {
        await parseBody(req);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ fault_message: "Invalid request" }));
      });

      const client = new FirecrackerClient(socketPath);

      try {
        await client.pause();
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(FirecrackerApiError);
        const error = e as FirecrackerApiError;
        expect(error.statusCode).toBe(400);
        expect(error.path).toBe("/vm");
        expect(error.faultMessage).toBe("Invalid request");
      }
    });

    it("should handle non-JSON error responses", async () => {
      await createMockServer(async (req, res) => {
        await parseBody(req);
        res.writeHead(500);
        res.end("Internal Server Error");
      });

      const client = new FirecrackerClient(socketPath);

      try {
        await client.pause();
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(FirecrackerApiError);
        const error = e as FirecrackerApiError;
        expect(error.statusCode).toBe(500);
        expect(error.faultMessage).toBe("Internal Server Error");
      }
    });
  });
});
