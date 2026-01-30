import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgressiveProgress } from "../progress-line.js";

describe("progress-line", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let logOutput: string[];

  beforeEach(() => {
    logOutput = [];
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logOutput.push(String(msg));
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe("createProgressiveProgress", () => {
    let stdoutOutput: string[];
    let originalWrite: typeof process.stdout.write;

    beforeEach(() => {
      stdoutOutput = [];
      originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        stdoutOutput.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
    });

    afterEach(() => {
      process.stdout.write = originalWrite;
    });

    it("should print step with empty circle on startStep", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Authentication");

      expect(logOutput[0]).toContain("○");
      expect(logOutput[0]).toContain("Authentication");
    });

    it("should print detail lines with connector prefix", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Authentication");
      progress.detail("Initiating device flow...");
      progress.detail("Waiting for confirmation...");

      expect(logOutput[1]).toContain("│");
      expect(logOutput[1]).toContain("Initiating device flow...");
      expect(logOutput[2]).toContain("│");
      expect(logOutput[2]).toContain("Waiting for confirmation...");
    });

    it("should print completed step with filled circle", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Authentication");
      progress.completeStep();

      expect(logOutput.some((line) => line.includes("●"))).toBe(true);
      expect(logOutput.some((line) => line.includes("Authentication"))).toBe(
        true,
      );
    });

    it("should print connector line after completed step", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Authentication");
      progress.completeStep();

      // Last output should be connector line
      const lastLog = logOutput[logOutput.length - 1];
      expect(lastLog).toContain("│");
    });

    it("should not print connector line for final step", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Complete");
      progress.setFinalStep();
      progress.completeStep();

      // Should have step line but no trailing connector
      expect(logOutput.some((line) => line.includes("●"))).toBe(true);
      expect(logOutput.filter((line) => line.includes("│")).length).toBe(0);
    });

    it("should print failed step with X", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Authentication");
      progress.failStep();

      expect(logOutput.some((line) => line.includes("✗"))).toBe(true);
      expect(logOutput.some((line) => line.includes("Authentication"))).toBe(
        true,
      );
    });

    it("should use ANSI escapes in interactive mode", () => {
      const progress = createProgressiveProgress(true);
      progress.startStep("Authentication");
      progress.detail("Some detail");
      progress.completeStep();

      // Should have written ANSI escape sequences to stdout
      expect(stdoutOutput.some((s) => s.includes("\x1b["))).toBe(true);
    });

    it("should not use ANSI escapes in non-interactive mode", () => {
      const progress = createProgressiveProgress(false);
      progress.startStep("Authentication");
      progress.detail("Some detail");
      progress.completeStep();

      // Should not have written any ANSI escape sequences
      expect(stdoutOutput.every((s) => !s.includes("\x1b["))).toBe(true);
    });
  });
});
