import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { VsockClient } from "../vsock.js";

/**
 * Integration tests for VsockClient and vsock-agent (Rust)
 *
 * These tests use Guest-initiated connection mode (same as production):
 * - Host (VsockClient) listens on "{socketPath}_1000"
 * - Agent connects to that socket
 */

const AGENT_BINARY = path.resolve(
  __dirname,
  "../../../../../../../crates/target/debug/vsock-agent",
);

const VSOCK_PORT = 1000;

// Helper to create a unique socket path for each test
function createSocketPath(): string {
  return path.join(os.tmpdir(), `vsock-test-${process.pid}-${Date.now()}.sock`);
}

// Helper to start the Rust agent (connects to host)
function startAgent(listenerPath: string): ChildProcess {
  const agent = spawn(AGENT_BINARY, ["--unix-socket", listenerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return agent;
}

// Helper to stop the agent and cleanup
async function stopAgent(
  agent: ChildProcess | null,
  socketPath: string,
): Promise<void> {
  if (agent && !agent.killed) {
    agent.kill("SIGTERM");
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        agent.kill("SIGKILL");
        resolve();
      }, 1000);
      agent.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // Clean up socket files
  const listenerPath = `${socketPath}_${VSOCK_PORT}`;
  for (const p of [socketPath, listenerPath]) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Ignore
      }
    }
  }
}

describe("VsockClient Integration Tests", () => {
  let socketPath: string;
  let agent: ChildProcess | null = null;
  let client: VsockClient | null = null;

  beforeAll(() => {
    // Verify agent binary exists (run `cargo build` in crates/ first)
    if (!fs.existsSync(AGENT_BINARY)) {
      throw new Error(
        `Agent binary not found: ${AGENT_BINARY}\n` +
          `Run 'cargo build' in the crates/ directory first.`,
      );
    }
  });

  beforeEach(async () => {
    socketPath = createSocketPath();
    client = new VsockClient(socketPath);

    // Host listens, then agent connects (same as production)
    const listenerPath = `${socketPath}_${VSOCK_PORT}`;
    const connectionPromise = client.waitForGuestConnection(5000);

    // Start agent after a small delay to ensure host is listening
    await new Promise((r) => setTimeout(r, 50));
    agent = startAgent(listenerPath);

    // Wait for connection
    await connectionPromise;
  });

  afterEach(async () => {
    // Close client first
    if (client) {
      client.close();
      client = null;
    }
    // Then stop agent
    await stopAgent(agent, socketPath);
    agent = null;
  });

  afterAll(() => {
    // Cleanup any leftover sockets
    const tmpDir = os.tmpdir();
    try {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        if (file.startsWith("vsock-test-") && file.endsWith(".sock")) {
          try {
            fs.unlinkSync(path.join(tmpDir, file));
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore
    }
  });

  describe("Connection", () => {
    it("should connect and verify reachability", async () => {
      const reachable = await client!.isReachable();
      expect(reachable).toBe(true);
    });

    it("should handle connection to non-existent socket", async () => {
      const badClient = new VsockClient("/non/existent/socket.sock");
      const reachable = await badClient.isReachable();
      expect(reachable).toBe(false);
    });
  });

  describe("exec", () => {
    it("should execute simple command", async () => {
      const result = await client!.exec("echo hello");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
      expect(result.stderr).toBe("");
    });

    it("should return stderr on error", async () => {
      const result = await client!.exec("echo error >&2 && exit 1");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("error");
    });

    it("should handle command with special characters", async () => {
      const result = await client!.exec("echo 'hello world' | cat");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
    });

    it("should handle multiline output", async () => {
      const result = await client!.exec("printf 'line1\\nline2\\nline3\\n'");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("line1");
      expect(lines[1]).toBe("line2");
      expect(lines[2]).toBe("line3");
    });

    it("should handle environment variables", async () => {
      const result = await client!.exec(
        "export TEST_VAR=hello; echo $TEST_VAR",
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    });

    it("should respect custom timeout parameter", async () => {
      // Command that completes quickly with short timeout
      const result = await client!.exec("echo fast", 5000);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("fast");
    });

    it("should return exit code 124 on timeout", async () => {
      // Command that sleeps longer than timeout (100ms timeout, 2s sleep)
      const result = await client!.exec("sleep 2", 100);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("Timeout");
    });
  });

  describe("execOrThrow", () => {
    it("should return stdout on success", async () => {
      const output = await client!.execOrThrow("echo success");
      expect(output.trim()).toBe("success");
    });

    it("should throw on non-zero exit code", async () => {
      await expect(client!.execOrThrow("exit 1")).rejects.toThrow(
        /Command failed/,
      );
    });

    it("should include stderr in error message", async () => {
      await expect(
        client!.execOrThrow("echo 'error message' >&2 && exit 1"),
      ).rejects.toThrow(/error message/);
    });
  });

  describe("File Operations", () => {
    it("should write and read file", async () => {
      const testPath = "/tmp/vsock-test-file.txt";
      const content = "Hello, vsock!";

      await client!.writeFile(testPath, content);
      const readContent = await client!.readFile(testPath);

      expect(readContent).toBe(content);

      // Cleanup
      await client!.exec(`rm -f ${testPath}`);
    });

    it("should write large file in chunks", async () => {
      const testPath = "/tmp/vsock-test-large.txt";
      // Create content larger than 65KB chunk size
      const content = "x".repeat(100000);

      await client!.writeFile(testPath, content);
      const readContent = await client!.readFile(testPath);

      expect(readContent.length).toBe(content.length);
      expect(readContent).toBe(content);

      // Cleanup
      await client!.exec(`rm -f ${testPath}`);
    });

    it("should write file with special characters", async () => {
      const testPath = "/tmp/vsock-test-special.txt";
      const content = 'Line1\nLine2\tTabbed\n"Quoted"';

      await client!.writeFile(testPath, content);
      const readContent = await client!.readFile(testPath);

      expect(readContent).toBe(content);

      // Cleanup
      await client!.exec(`rm -f ${testPath}`);
    });

    it("should throw on reading non-existent file", async () => {
      await expect(
        client!.readFile("/non/existent/file.txt"),
      ).rejects.toThrow();
    });

    it("should write file with sudo (or fail gracefully without passwordless sudo)", async () => {
      // Check if passwordless sudo is available
      const sudoCheck = await client!.exec("sudo -n true 2>/dev/null");
      const hasSudo = sudoCheck.exitCode === 0;

      const testPath = "/tmp/vsock-test-sudo.txt";
      const content = "sudo test content";

      if (hasSudo) {
        // Passwordless sudo available - test the full flow
        await client!.writeFileWithSudo(testPath, content);
        const readContent = await client!.readFile(testPath);
        expect(readContent).toBe(content);
        await client!.exec(`rm -f ${testPath}`);
      } else {
        // No passwordless sudo - verify it fails with expected error
        await expect(
          client!.writeFileWithSudo(testPath, content),
        ).rejects.toThrow(/sudo|password/i);
      }
    });
  });

  describe("Directory Operations", () => {
    it("should create directory", async () => {
      const testDir = "/tmp/vsock-test-dir";

      await client!.mkdir(testDir);
      const exists = await client!.exists(testDir);

      expect(exists).toBe(true);

      // Cleanup
      await client!.exec(`rm -rf ${testDir}`);
    });

    it("should create nested directories", async () => {
      const testDir = "/tmp/vsock-test-nested/a/b/c";

      await client!.mkdir(testDir);
      const exists = await client!.exists(testDir);

      expect(exists).toBe(true);

      // Cleanup
      await client!.exec(`rm -rf /tmp/vsock-test-nested`);
    });

    it("should check file existence", async () => {
      const existsResult = await client!.exists("/etc/passwd");
      expect(existsResult).toBe(true);

      const notExistsResult = await client!.exists("/non/existent/path");
      expect(notExistsResult).toBe(false);
    });
  });

  describe("Connection Lifecycle", () => {
    it("should handle multiple sequential commands", async () => {
      for (let i = 0; i < 5; i++) {
        const result = await client!.exec(`echo ${i}`);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(String(i));
      }
    });
  });
});
