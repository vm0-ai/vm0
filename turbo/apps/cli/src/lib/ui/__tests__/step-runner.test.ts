import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStepRunner } from "../step-runner.js";

describe("step-runner", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let logOutput: string[];
  let stdoutOutput: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    logOutput = [];
    stdoutOutput = [];

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logOutput.push(String(msg));
    });

    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutOutput.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.stdout.write = originalWrite;
  });

  describe("createStepRunner", () => {
    describe("interactive mode", () => {
      it("should print step header with empty circle on start", async () => {
        const runner = createStepRunner(true);

        await runner.step("Test Step", async () => {
          // Empty step
        });

        // First log should be the step header
        expect(logOutput[0]).toContain("○");
        expect(logOutput[0]).toContain("Test Step");
      });

      it("should print completed step with filled circle after clear", async () => {
        const runner = createStepRunner(true);

        await runner.step("Test Step", async () => {
          // Empty step
        });

        // Should have completed step (after redraw)
        expect(logOutput.some((line) => line.includes("●"))).toBe(true);
        expect(logOutput.some((line) => line.includes("Test Step"))).toBe(true);
      });

      it("should print connector line after completed step", async () => {
        const runner = createStepRunner(true);

        await runner.step("Test Step", async () => {
          // Empty step
        });

        // Last log should be connector (after redraw)
        const lastLog = logOutput[logOutput.length - 1];
        expect(lastLog).toContain("│");
      });

      it("should not print connector line for final step", async () => {
        const runner = createStepRunner(true);

        await runner.finalStep("Final Step", async () => {
          // Empty step
        });

        // Should have completed step but no trailing connector
        expect(logOutput.some((line) => line.includes("●"))).toBe(true);
        // Final output should just be "● Final Step" with no connector
        expect(logOutput[logOutput.length - 1]).toContain("●");
        expect(logOutput[logOutput.length - 1]).toContain("Final Step");
      });

      it("should clear screen on step completion", async () => {
        const runner = createStepRunner(true);

        await runner.step("Test Step", async (ctx) => {
          ctx.detail("Detail 1");
          ctx.detail("Detail 2");
        });

        // Should have printed details during execution
        expect(logOutput.some((line) => line.includes("Detail 1"))).toBe(true);
        expect(logOutput.some((line) => line.includes("Detail 2"))).toBe(true);

        // Should have used clear screen and home cursor
        expect(stdoutOutput.some((s) => s.includes("\x1b[2J\x1b[H"))).toBe(
          true,
        );
      });

      it("should handle connector lines during step", async () => {
        const runner = createStepRunner(true);

        await runner.step("Test Step", async (ctx) => {
          ctx.connector();
          ctx.detail("After connector");
        });

        // Should have cleared screen
        expect(stdoutOutput.some((s) => s.includes("\x1b[2J\x1b[H"))).toBe(
          true,
        );
      });

      it("should clear screen even for steps with prompts", async () => {
        const runner = createStepRunner(true);
        const mockPrompt = vi.fn().mockResolvedValue("selected");

        await runner.step("Test Step", async (ctx) => {
          ctx.connector();
          await ctx.prompt(mockPrompt);
          ctx.detail("After prompt");
        });

        // Should have called the prompt function
        expect(mockPrompt).toHaveBeenCalled();

        // Should have cleared screen (clean screen works regardless of prompts)
        expect(stdoutOutput.some((s) => s.includes("\x1b[2J\x1b[H"))).toBe(
          true,
        );

        // Step should complete
        expect(logOutput.some((line) => line.includes("●"))).toBe(true);
      });

      it("should handle cancelled prompt (returns undefined)", async () => {
        const runner = createStepRunner(true);
        const mockPrompt = vi.fn().mockResolvedValue(undefined);

        await runner.step("Test Step", async (ctx) => {
          const result = await ctx.prompt(mockPrompt);
          expect(result).toBeUndefined();
        });

        // Step should still complete successfully
        expect(logOutput.some((line) => line.includes("●"))).toBe(true);
      });
    });

    describe("non-interactive mode", () => {
      it("should not use ANSI escape sequences", async () => {
        const runner = createStepRunner(false);

        await runner.step("Test Step", async (ctx) => {
          ctx.detail("Detail 1");
          ctx.detail("Detail 2");
        });

        // Should NOT have written any ANSI escape sequences
        expect(stdoutOutput.every((s) => !s.includes("\x1b["))).toBe(true);
      });

      it("should still print all output linearly", async () => {
        const runner = createStepRunner(false);

        await runner.step("Test Step", async (ctx) => {
          ctx.detail("Detail 1");
          ctx.detail("Detail 2");
        });

        // All lines should be in output
        expect(logOutput.some((line) => line.includes("○"))).toBe(true);
        expect(logOutput.some((line) => line.includes("Detail 1"))).toBe(true);
        expect(logOutput.some((line) => line.includes("Detail 2"))).toBe(true);
        expect(logOutput.some((line) => line.includes("●"))).toBe(true);
      });
    });

    describe("error handling", () => {
      it("should show error indicator when step throws", async () => {
        const runner = createStepRunner(true);

        await expect(
          runner.step("Failing Step", async () => {
            throw new Error("Step failed");
          }),
        ).rejects.toThrow("Step failed");

        // Should show error indicator (after redraw)
        expect(logOutput.some((line) => line.includes("✗"))).toBe(true);
        expect(logOutput.some((line) => line.includes("Failing Step"))).toBe(
          true,
        );
      });

      it("should still print connector after failed step", async () => {
        const runner = createStepRunner(true);

        try {
          await runner.step("Failing Step", async () => {
            throw new Error("Step failed");
          });
        } catch {
          // Expected
        }

        // Should have connector after failed step (after redraw)
        const lastLog = logOutput[logOutput.length - 1];
        expect(lastLog).toContain("│");
      });
    });

    describe("multiple steps", () => {
      it("should handle sequential steps correctly", async () => {
        const runner = createStepRunner(false); // Use non-interactive for easier assertion

        await runner.step("Step 1", async (ctx) => {
          ctx.detail("Step 1 detail");
        });

        await runner.step("Step 2", async (ctx) => {
          ctx.detail("Step 2 detail");
        });

        await runner.finalStep("Step 3", async () => {
          // Empty final step
        });

        // All steps should appear with completed indicator
        expect(logOutput.filter((line) => line.includes("●")).length).toBe(3);

        // Count connector lines (lines that are just "│" with possible ANSI codes)
        // Step 1 completes → connector, Step 2 completes → connector, Step 3 (final) → no connector
        const connectorLines = logOutput.filter(
          (line) =>
            line.includes("│") &&
            !line.includes("Step") &&
            !line.includes("detail"),
        );
        expect(connectorLines.length).toBeGreaterThanOrEqual(2);
      });

      it("should redraw all completed steps after each step", async () => {
        const runner = createStepRunner(true);

        await runner.step("Step 1", async () => {
          // Empty step
        });

        // After step 1, clear count should be 1
        const clearCount1 = stdoutOutput.filter((s) =>
          s.includes("\x1b[2J\x1b[H"),
        ).length;
        expect(clearCount1).toBe(1);

        await runner.step("Step 2", async () => {
          // Empty step
        });

        // After step 2, clear count should be 2
        const clearCount2 = stdoutOutput.filter((s) =>
          s.includes("\x1b[2J\x1b[H"),
        ).length;
        expect(clearCount2).toBe(2);

        // Both steps should be in log (redrawn after step 2)
        const step1Lines = logOutput.filter((line) => line.includes("Step 1"));
        const step2Lines = logOutput.filter((line) => line.includes("Step 2"));
        expect(step1Lines.length).toBeGreaterThanOrEqual(2); // Header + redrawn
        expect(step2Lines.length).toBeGreaterThanOrEqual(2); // Header + redrawn
      });

      it("should call header function when redrawing", async () => {
        const headerFn = vi.fn(() => {
          console.log("=== HEADER ===");
        });

        const runner = createStepRunner({
          interactive: true,
          header: headerFn,
        });

        await runner.step("Test Step", async () => {
          // Empty step
        });

        // Header function should have been called during redraw
        expect(headerFn).toHaveBeenCalled();

        // Header output should appear after clear
        expect(logOutput.some((line) => line.includes("=== HEADER ==="))).toBe(
          true,
        );
      });

      it("should call header function for each step redraw", async () => {
        const headerFn = vi.fn(() => {
          console.log("BANNER");
        });

        const runner = createStepRunner({
          interactive: true,
          header: headerFn,
        });

        await runner.step("Step 1", async () => {});
        await runner.step("Step 2", async () => {});

        // Header should be called twice (once per redraw)
        expect(headerFn).toHaveBeenCalledTimes(2);
      });
    });
  });
});
