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
 * Integration tests for VsockClient and vsock-agent.py
 *
 * These tests start a real Python vsock-agent process in UDS mode
 * and verify the full communication protocol between host and guest.
 */

const AGENT_SCRIPT = path.resolve(
  __dirname,
  "../../../../scripts/deploy/vsock-agent.py",
);

// Helper to create a unique socket path for each test
function createSocketPath(): string {
  return path.join(os.tmpdir(), `vsock-test-${process.pid}-${Date.now()}.sock`);
}

// Helper to wait for socket file to exist
async function waitForSocket(
  socketPath: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(socketPath)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Socket ${socketPath} not created within ${timeoutMs}ms`);
}

// Helper to start the Python agent
async function startAgent(socketPath: string): Promise<ChildProcess> {
  const agent = spawn("python3", [AGENT_SCRIPT, "--unix-socket", socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for socket to be created
  await waitForSocket(socketPath);

  // Give agent a moment to start listening
  await new Promise((r) => setTimeout(r, 100));

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

  // Clean up socket file
  if (socketPath && fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore
    }
  }
}

describe("VsockClient Integration Tests", () => {
  let socketPath: string;
  let agent: ChildProcess | null = null;
  let client: VsockClient | null = null;

  beforeAll(() => {
    // Verify agent script exists
    if (!fs.existsSync(AGENT_SCRIPT)) {
      throw new Error(`Agent script not found: ${AGENT_SCRIPT}`);
    }
  });

  beforeEach(async () => {
    socketPath = createSocketPath();
    agent = await startAgent(socketPath);
    client = new VsockClient(socketPath);
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

    it("should wait until reachable", async () => {
      await client!.waitUntilReachable(5000, 100);
      // If we get here without error, the test passes
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

    it("should reconnect after close", async () => {
      // First connection
      let result = await client!.exec("echo first");
      expect(result.stdout.trim()).toBe("first");

      // Close connection
      client!.close();

      // New connection should work (client auto-reconnects)
      result = await client!.exec("echo second");
      expect(result.stdout.trim()).toBe("second");
    });
  });
});
