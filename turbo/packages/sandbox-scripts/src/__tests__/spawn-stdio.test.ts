import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

/**
 * Tests for spawn stdio configuration.
 *
 * These tests verify that our spawn configuration doesn't cause processes to hang.
 * The key issue is that using stdio: ["pipe", "pipe", "pipe"] without closing stdin
 * can cause child processes to hang waiting for EOF.
 *
 * Our solution is to use ["ignore", "pipe", "pipe"] for stdin when we don't need
 * to send input to the child process.
 */
describe("spawn-stdio", () => {
  describe("stdin configuration", () => {
    it('should complete without hanging when stdin is "ignore"', async () => {
      // This is the correct configuration we use in run-agent.ts
      const proc = spawn("echo", ["hello"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = await collectStream(proc.stdout);
      const exitCode = await waitForExit(proc);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("hello");
    });

    it("should capture stdout correctly", async () => {
      const proc = spawn("echo", ["test output"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = await collectStream(proc.stdout);
      const exitCode = await waitForExit(proc);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("test output");
    });

    it("should capture stderr correctly", async () => {
      // Use sh -c to redirect to stderr
      const proc = spawn("sh", ["-c", 'echo "error message" >&2'], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stderr = await collectStream(proc.stderr);
      const exitCode = await waitForExit(proc);

      expect(exitCode).toBe(0);
      expect(stderr.trim()).toBe("error message");
    });

    it("should handle process that exits with non-zero code", async () => {
      const proc = spawn("sh", ["-c", "exit 1"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitCode = await waitForExit(proc);

      expect(exitCode).toBe(1);
    });

    it('should not hang when stdin is "ignore" for process that would read stdin', async () => {
      // cat without arguments would normally read from stdin
      // With stdin="ignore", it should exit immediately
      const proc = spawn("cat", [], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Set a timeout to detect hanging
      const timeoutMs = 1000;
      const exitCode = await Promise.race([
        waitForExit(proc),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("Process hung")), timeoutMs),
        ),
      ]);

      expect(exitCode).toBe(0);
    });
  });
});

/**
 * Collect all data from a readable stream into a string
 */
function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve) => {
    if (!stream) {
      resolve("");
      return;
    }

    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", () => resolve(""));
  });
}

/**
 * Wait for process to exit and return exit code
 */
function waitForExit(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });
}
