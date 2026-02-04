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

  describe("spawnAndWatch / waitForExit (Event-driven)", () => {
    it("should spawn process and return pid immediately", async () => {
      const { pid } = await client!.spawnAndWatch("echo hello");
      expect(pid).toBeGreaterThan(0);

      // Wait for exit
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("hello");
    });

    it("should receive exit event with exit code", async () => {
      const { pid } = await client!.spawnAndWatch("exit 42");
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(42);
    });

    it("should receive stderr in exit event", async () => {
      const { pid } = await client!.spawnAndWatch("echo error >&2 && exit 1");
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(1);
      expect(exitEvent.stderr.trim()).toBe("error");
    });

    it("should handle concurrent spawn and wait", async () => {
      // Spawn two processes
      const spawn1 = await client!.spawnAndWatch("sleep 0.1 && echo first");
      const spawn2 = await client!.spawnAndWatch("echo second");

      // Wait for both (in reverse order to test proper PID tracking)
      const exit2 = await client!.waitForExit(spawn2.pid, 5000);
      const exit1 = await client!.waitForExit(spawn1.pid, 5000);

      expect(exit1.exitCode).toBe(0);
      expect(exit1.stdout.trim()).toBe("first");
      expect(exit2.exitCode).toBe(0);
      expect(exit2.stdout.trim()).toBe("second");
    });

    it("should timeout on long-running process with timeout parameter", async () => {
      const { pid } = await client!.spawnAndWatch("sleep 10", 100);

      // Wait for exit - should receive timeout (exit code 124)
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(124);
      expect(exitEvent.stderr).toContain("Timeout");
    });

    it("should timeout waitForExit if process never exits", async () => {
      // Spawn a process that sleeps for a long time, but don't set spawn timeout
      const { pid } = await client!.spawnAndWatch("sleep 60");

      // waitForExit should timeout after 100ms
      await expect(client!.waitForExit(pid, 100)).rejects.toThrow(/Timeout/);

      // Kill the process to clean up
      await client!.exec(`kill -9 ${pid} 2>/dev/null || true`);
    });

    it("should handle process with large output", async () => {
      // Generate 10KB of output
      const { pid } = await client!.spawnAndWatch(
        "dd if=/dev/zero bs=1024 count=10 2>/dev/null | base64",
      );
      const exitEvent = await client!.waitForExit(pid, 10000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.length).toBeGreaterThan(10000);
    });

    it("should handle process killed by signal (SIGTERM)", async () => {
      // Start a process that waits, then kill it
      // Use exec rather than sleep to avoid shell wrapper issues
      const { pid } = await client!.spawnAndWatch("exec sleep 60");

      // Give the process time to start
      await new Promise((r) => setTimeout(r, 100));

      // Kill the process with SIGTERM (signal 15) - kill entire process group
      await client!.exec(`kill -15 -${pid} 2>/dev/null || kill -15 ${pid}`);

      // Wait for exit - should receive exit code 143 (128 + 15)
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(143); // 128 + SIGTERM (15)
    });

    it("should handle process killed by SIGKILL", async () => {
      // Start a process that waits, then kill it
      // Use exec rather than sleep to avoid shell wrapper issues
      const { pid } = await client!.spawnAndWatch("exec sleep 60");

      // Give the process time to start
      await new Promise((r) => setTimeout(r, 100));

      // Kill the process with SIGKILL (signal 9) - kill entire process group
      await client!.exec(`kill -9 -${pid} 2>/dev/null || kill -9 ${pid}`);

      // Wait for exit - should receive exit code 137 (128 + 9)
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(137); // 128 + SIGKILL (9)
    });

    it("should handle spawning multiple processes rapidly", async () => {
      // Spawn 5 processes rapidly
      const spawns = await Promise.all([
        client!.spawnAndWatch("echo p1"),
        client!.spawnAndWatch("echo p2"),
        client!.spawnAndWatch("echo p3"),
        client!.spawnAndWatch("echo p4"),
        client!.spawnAndWatch("echo p5"),
      ]);

      // All should have different PIDs
      const pids = spawns.map((s) => s.pid);
      const uniquePids = new Set(pids);
      expect(uniquePids.size).toBe(5);

      // Wait for all to complete
      const exits = await Promise.all(
        spawns.map((s) => client!.waitForExit(s.pid, 5000)),
      );

      // All should exit successfully
      for (let i = 0; i < 5; i++) {
        const exit = exits[i]!;
        expect(exit.exitCode).toBe(0);
        expect(exit.stdout.trim()).toBe(`p${i + 1}`);
      }
    });

    it("should handle process with no output", async () => {
      const { pid } = await client!.spawnAndWatch("true"); // 'true' exits 0 with no output
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toBe("");
      expect(exitEvent.stderr).toBe("");
    });

    it("should handle process with both stdout and stderr", async () => {
      const { pid } = await client!.spawnAndWatch(
        "echo out && echo err >&2 && exit 2",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(2);
      expect(exitEvent.stdout.trim()).toBe("out");
      expect(exitEvent.stderr.trim()).toBe("err");
    });

    it("should handle multiline output in spawn mode", async () => {
      const { pid } = await client!.spawnAndWatch(
        "printf 'line1\\nline2\\nline3\\n'",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      const lines = exitEvent.stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("line1");
      expect(lines[1]).toBe("line2");
      expect(lines[2]).toBe("line3");
    });

    it("should handle non-existent command", async () => {
      const { pid } = await client!.spawnAndWatch(
        "nonexistent_command_12345 2>&1",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).not.toBe(0);
      // stderr or stdout should contain error message
      const output = exitEvent.stderr || exitEvent.stdout;
      expect(output.toLowerCase()).toMatch(/not found|command not found/);
    });

    it("should handle environment variables in spawned process", async () => {
      const { pid } = await client!.spawnAndWatch(
        "export MY_VAR=hello_spawn; echo $MY_VAR",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("hello_spawn");
    });

    it("should handle process that outputs special characters", async () => {
      const { pid } = await client!.spawnAndWatch(
        "printf 'tab:\\there\\nnewline done'",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("tab:\there");
      expect(exitEvent.stdout).toContain("newline done");
    });

    it("should handle zero exit code with stderr output", async () => {
      // Some commands output warnings to stderr but still exit 0
      const { pid } = await client!.spawnAndWatch(
        "echo warning >&2 && echo success && exit 0",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("success");
      expect(exitEvent.stderr.trim()).toBe("warning");
    });

    it("should handle unicode and non-ASCII output", async () => {
      const { pid } = await client!.spawnAndWatch(
        "printf '你好世界\\nこんにちは\\n🎉emoji🚀'",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("你好世界");
      expect(exitEvent.stdout).toContain("こんにちは");
      expect(exitEvent.stdout).toContain("🎉emoji🚀");
    });

    it("should handle complex pipe chains", async () => {
      const { pid } = await client!.spawnAndWatch(
        "echo 'hello world' | tr 'a-z' 'A-Z' | sed 's/WORLD/UNIVERSE/'",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("HELLO UNIVERSE");
    });

    it("should return different PIDs for same command spawned multiple times", async () => {
      const spawn1 = await client!.spawnAndWatch("echo test");
      const spawn2 = await client!.spawnAndWatch("echo test");
      const spawn3 = await client!.spawnAndWatch("echo test");

      // All PIDs should be different
      expect(spawn1.pid).not.toBe(spawn2.pid);
      expect(spawn2.pid).not.toBe(spawn3.pid);
      expect(spawn1.pid).not.toBe(spawn3.pid);

      // All should complete successfully
      const exits = await Promise.all([
        client!.waitForExit(spawn1.pid, 5000),
        client!.waitForExit(spawn2.pid, 5000),
        client!.waitForExit(spawn3.pid, 5000),
      ]);
      for (const exit of exits) {
        expect(exit.exitCode).toBe(0);
      }
    });

    it("should timeout waitForExit for never-spawned PID", async () => {
      // PID 99999999 was never spawned - should timeout
      await expect(client!.waitForExit(99999999, 100)).rejects.toThrow(
        /Timeout/,
      );
    });

    it("should handle empty command gracefully", async () => {
      // Empty command typically results in shell doing nothing and exiting 0
      const { pid } = await client!.spawnAndWatch("");
      const exitEvent = await client!.waitForExit(pid, 5000);

      // Shell should handle empty command (exit 0 or small exit code)
      expect(exitEvent.exitCode).toBeLessThanOrEqual(127);
    });

    it("should handle command with only whitespace", async () => {
      const { pid } = await client!.spawnAndWatch("   ");
      const exitEvent = await client!.waitForExit(pid, 5000);

      // Shell should handle whitespace-only command
      expect(exitEvent.exitCode).toBeLessThanOrEqual(127);
    });

    it("should handle process that forks child processes", async () => {
      // Parent spawns a child that echoes, then parent exits
      // Child output should still be captured
      const { pid } = await client!.spawnAndWatch(
        "sh -c 'echo parent; (echo child) & wait'",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("parent");
      expect(exitEvent.stdout).toContain("child");
    });

    it("should handle interleaved stdout and stderr", async () => {
      const { pid } = await client!.spawnAndWatch(
        "echo out1 && echo err1 >&2 && echo out2 && echo err2 >&2",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("out1");
      expect(exitEvent.stdout).toContain("out2");
      expect(exitEvent.stderr).toContain("err1");
      expect(exitEvent.stderr).toContain("err2");
    });

    it("should handle very long command", async () => {
      // Generate a command with many arguments
      const args = Array.from({ length: 100 }, (_, i) => `arg${i}`).join(" ");
      const { pid } = await client!.spawnAndWatch(`echo ${args}`);
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("arg0");
      expect(exitEvent.stdout).toContain("arg99");
    });

    it("should handle subshell execution", async () => {
      const { pid } = await client!.spawnAndWatch(
        "(cd /tmp && pwd && echo done)",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("/tmp");
      expect(exitEvent.stdout).toContain("done");
    });

    it("should handle command substitution", async () => {
      const { pid } = await client!.spawnAndWatch('echo "Current dir: $(pwd)"');
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout).toContain("Current dir:");
      expect(exitEvent.stdout).toContain("/");
    });

    it("should handle heredoc input", async () => {
      // Use POSIX-compatible heredoc syntax (works in sh, bash, etc.)
      const { pid } = await client!.spawnAndWatch(
        "cat << 'EOF'\nhello from heredoc\nEOF",
      );
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("hello from heredoc");
    });

    it("should handle process that sleeps briefly then outputs", async () => {
      // Ensures we properly wait for output after short delay
      const { pid } = await client!.spawnAndWatch("sleep 0.2 && echo delayed");
      const exitEvent = await client!.waitForExit(pid, 5000);

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("delayed");
    });

    it("should throw error when calling waitForExit twice for same PID", async () => {
      // Spawn a slow process
      const { pid } = await client!.spawnAndWatch("sleep 1");

      // First waitForExit call - should not throw
      const promise1 = client!.waitForExit(pid, 5000);

      // Second waitForExit call for same PID - should throw
      await expect(client!.waitForExit(pid, 5000)).rejects.toThrow(
        /Already waiting for process/,
      );

      // Clean up - wait for the first promise and kill the process
      await client!.exec(`kill -9 ${pid} 2>/dev/null || true`);
      await promise1.catch(() => {}); // Ignore any errors
    });

    it("should throw error when calling waitForExit after connection closed", async () => {
      // Spawn a process first
      const { pid } = await client!.spawnAndWatch("sleep 5");

      // Close the connection
      client!.close();

      // Now waitForExit should throw
      await expect(client!.waitForExit(pid, 5000)).rejects.toThrow(
        /Not connected/,
      );
    });

    it("should throw error when calling spawnAndWatch after connection closed", async () => {
      // Close the connection
      client!.close();

      // Now spawnAndWatch should throw
      await expect(client!.spawnAndWatch("echo test")).rejects.toThrow(
        /Not connected/,
      );
    });

    it("should handle waitForExit called after exit event already cached", async () => {
      // Spawn a very fast process
      const { pid } = await client!.spawnAndWatch("echo cached_test");

      // Wait long enough for the exit event to arrive and be cached
      await new Promise((r) => setTimeout(r, 300));

      // Now call waitForExit - should return immediately from cache
      const startTime = Date.now();
      const exitEvent = await client!.waitForExit(pid, 5000);
      const elapsed = Date.now() - startTime;

      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("cached_test");
      // Should return almost immediately (< 100ms) since it's cached
      expect(elapsed).toBeLessThan(100);
    });

    it("should allow calling waitForExit again after timeout for same PID", async () => {
      // Spawn a process that takes 500ms
      const { pid } = await client!.spawnAndWatch("sleep 0.5 && echo done");

      // First waitForExit with very short timeout - should fail
      await expect(client!.waitForExit(pid, 50)).rejects.toThrow(/Timeout/);

      // After timeout, should be able to call waitForExit again
      // This time with longer timeout - should succeed
      const exitEvent = await client!.waitForExit(pid, 5000);
      expect(exitEvent.exitCode).toBe(0);
      expect(exitEvent.stdout.trim()).toBe("done");
    });

    it("should handle very fast process that exits before waitForExit is called", async () => {
      // Spawn multiple very fast processes in sequence
      // The exit events might arrive before we call waitForExit
      const results: string[] = [];

      for (let i = 0; i < 3; i++) {
        const { pid } = await client!.spawnAndWatch(`echo fast${i}`);
        // Small delay to let exit event potentially arrive and be cached
        await new Promise((r) => setTimeout(r, 50));
        const exitEvent = await client!.waitForExit(pid, 5000);
        results.push(exitEvent.stdout.trim());
      }

      expect(results).toEqual(["fast0", "fast1", "fast2"]);
    });

    it("should handle close() being called multiple times", async () => {
      // Close should be idempotent - calling it multiple times should not throw
      client!.close();
      client!.close();
      client!.close();

      // Should still report as not connected
      await expect(client!.spawnAndWatch("echo test")).rejects.toThrow(
        /Not connected/,
      );
    });

    it("should cleanly reject pending waitForExit when close() is called during wait", async () => {
      // Spawn a slow process
      const { pid } = await client!.spawnAndWatch("sleep 10");

      // Start waiting - this will create a pending exit
      const waitPromise = client!.waitForExit(pid, 30000);

      // Close immediately
      client!.close();

      // waitForExit should be rejected with connection closed
      await expect(waitPromise).rejects.toThrow(/Connection closed/);
    });

    it("should return error result for exec when close() is called during exec", async () => {
      // Start an exec that won't complete before close
      const execPromise = client!.exec("sleep 10", 30000);

      // Close immediately
      client!.close();

      // exec returns error result instead of throwing (by design)
      const result = await execPromise;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Connection closed");
    });
  });

  describe("reconnection", () => {
    it("should reconnect after host closes connection", async () => {
      // Verify initial connection works
      const beforeResult = await client!.exec("echo connected");
      expect(beforeResult.exitCode).toBe(0);
      expect(beforeResult.stdout.trim()).toBe("connected");

      // Close host connection (simulating snapshot pause scenario)
      // The same agent process should automatically reconnect
      client!.close();
      client = null;

      // Create new client on the SAME socket path
      // Agent will reconnect to this listener (retry loop with 100ms delay)
      const newClient = new VsockClient(socketPath);
      const connectionPromise = newClient.waitForGuestConnection(5000);

      // Wait for agent to reconnect (agent retries every 100ms)
      await connectionPromise;

      // Verify agent is functional after reconnect
      const afterResult = await newClient.exec("echo reconnected");
      expect(afterResult.exitCode).toBe(0);
      expect(afterResult.stdout.trim()).toBe("reconnected");

      // Update client for afterEach cleanup
      client = newClient;
    });
  });

  describe("shutdown", () => {
    it("should send shutdown request and receive acknowledgment", async () => {
      const result = await client!.shutdown(5000);
      expect(result).toBe(true);
    });

    it("should return false when not connected", async () => {
      client!.close();
      const result = await client!.shutdown(1000);
      expect(result).toBe(false);
    });

    it("should return false on timeout if agent does not respond", async () => {
      // Kill the agent so it can't respond
      if (agent && !agent.killed) {
        agent.kill("SIGKILL");
        // Wait for process to actually exit (more robust than fixed delay)
        await new Promise<void>((resolve) => {
          agent!.on("exit", resolve);
        });
      }

      const result = await client!.shutdown(100);
      expect(result).toBe(false);
    });

    it("should handle multiple shutdown calls", async () => {
      // First shutdown should succeed
      const result1 = await client!.shutdown(5000);
      expect(result1).toBe(true);

      // Second shutdown should also succeed (agent still running)
      const result2 = await client!.shutdown(5000);
      expect(result2).toBe(true);
    });

    it("should not interfere with concurrent exec", async () => {
      // Start a slow exec
      const execPromise = client!.exec("sleep 0.2 && echo done", 5000);

      // Call shutdown while exec is in progress
      const shutdownResult = await client!.shutdown(5000);
      expect(shutdownResult).toBe(true);

      // Exec should still complete normally
      const execResult = await execPromise;
      expect(execResult.exitCode).toBe(0);
      expect(execResult.stdout.trim()).toBe("done");
    });

    it("should exit gracefully without reconnecting after shutdown", async () => {
      // Capture agent stderr to verify no reconnection attempts
      let agentOutput = "";
      agent!.stderr!.on("data", (data: Buffer) => {
        agentOutput += data.toString();
      });

      // Send shutdown and verify ack
      const shutdownResult = await client!.shutdown(5000);
      expect(shutdownResult).toBe(true);

      // Close client connection (this triggers agent to check shutdown flag)
      client!.close();
      client = null;

      // Wait for agent to exit (should exit gracefully, not timeout)
      const exitCode = await new Promise<number | null>((resolve) => {
        const timeout = setTimeout(() => {
          // If agent doesn't exit within 1s, it's likely stuck reconnecting
          resolve(null);
        }, 1000);

        agent!.on("exit", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });

      // Agent should have exited (not null = didn't timeout)
      expect(exitCode).not.toBeNull();

      // Verify agent logged "Shutdown complete, exiting" and NOT "reconnecting"
      expect(agentOutput).toContain("Shutdown complete, exiting");
      expect(agentOutput).not.toMatch(/reconnecting.*\/50/);
    });
  });

  describe("Protocol Error Handling", () => {
    it("should disconnect and reconnect on oversized message", async () => {
      // First verify the connection is working
      const pingResult = await client!.exec("echo test");
      expect(pingResult.exitCode).toBe(0);

      // Track agent logs
      let agentOutput = "";
      agent!.stderr!.on("data", (data: Buffer) => {
        agentOutput += data.toString();
      });

      // Create a new client to listen for reconnection BEFORE sending malformed message
      // This ensures the agent has somewhere to reconnect to
      const newClient = new VsockClient(socketPath);
      const reconnectPromise = newClient.waitForGuestConnection(5000);

      // Send a malformed message with oversized length header (> 16MB)
      // Protocol: [4-byte length][1-byte type][4-byte seq][payload]
      // This creates a header claiming 20MB message size
      const malformedHeader = Buffer.alloc(4);
      malformedHeader.writeUInt32BE(20 * 1024 * 1024, 0); // 20MB - exceeds MAX_MESSAGE_SIZE
      client!.sendRawForTesting(malformedHeader);

      // Close old client (agent will detect disconnection)
      client!.close();
      client = null;

      // Wait for agent to reconnect to the new client
      await reconnectPromise;
      client = newClient;

      // Verify agent logged the protocol error
      expect(agentOutput).toContain("Message too large");

      // Verify connection works again after reconnection
      const postErrorResult = await client!.exec("echo recovered");
      expect(postErrorResult.exitCode).toBe(0);
      expect(postErrorResult.stdout.trim()).toBe("recovered");
    });
  });
});
