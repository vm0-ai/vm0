import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderProgressLine,
  createOnboardProgress,
  type Step,
} from "../progress-line.js";

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

  describe("renderProgressLine", () => {
    it("should render completed steps with filled circle", () => {
      const steps: Step[] = [{ label: "Step 1", status: "completed" }];
      renderProgressLine(steps);

      expect(logOutput[0]).toContain("●");
      expect(logOutput[0]).toContain("Step 1");
    });

    it("should render in-progress steps with half circle", () => {
      const steps: Step[] = [{ label: "Step 1", status: "in-progress" }];
      renderProgressLine(steps);

      expect(logOutput[0]).toContain("◐");
      expect(logOutput[0]).toContain("Step 1");
    });

    it("should render pending steps with empty circle", () => {
      const steps: Step[] = [{ label: "Step 1", status: "pending" }];
      renderProgressLine(steps);

      expect(logOutput[0]).toContain("○");
      expect(logOutput[0]).toContain("Step 1");
    });

    it("should render failed steps with X", () => {
      const steps: Step[] = [{ label: "Step 1", status: "failed" }];
      renderProgressLine(steps);

      expect(logOutput[0]).toContain("✗");
      expect(logOutput[0]).toContain("Step 1");
    });

    it("should render connecting lines between steps", () => {
      const steps: Step[] = [
        { label: "Step 1", status: "completed" },
        { label: "Step 2", status: "pending" },
      ];
      renderProgressLine(steps);

      expect(logOutput.length).toBe(3);
      expect(logOutput[1]).toContain("│");
    });

    it("should not render line after last step", () => {
      const steps: Step[] = [{ label: "Only Step", status: "completed" }];
      renderProgressLine(steps);

      expect(logOutput.length).toBe(1);
    });
  });

  describe("createOnboardProgress", () => {
    it("should create progress with 4 steps", () => {
      const progress = createOnboardProgress();

      expect(progress.steps.length).toBe(4);
      expect(progress.steps[0]?.label).toBe("Authentication");
      expect(progress.steps[1]?.label).toBe("Model Provider Setup");
      expect(progress.steps[2]?.label).toBe("Create Agent");
      expect(progress.steps[3]?.label).toBe("Complete");
    });

    it("should initialize all steps as pending", () => {
      const progress = createOnboardProgress();

      for (const step of progress.steps) {
        expect(step.status).toBe("pending");
      }
    });

    it("should update step status correctly", () => {
      const progress = createOnboardProgress();

      progress.update(0, "completed");
      expect(progress.steps[0]?.status).toBe("completed");

      progress.update(1, "in-progress");
      expect(progress.steps[1]?.status).toBe("in-progress");

      progress.update(2, "failed");
      expect(progress.steps[2]?.status).toBe("failed");
    });

    it("should handle out of bounds index gracefully", () => {
      const progress = createOnboardProgress();

      progress.update(-1, "completed");
      progress.update(10, "completed");

      for (const step of progress.steps) {
        expect(step.status).toBe("pending");
      }
    });

    it("should render progress line", () => {
      const progress = createOnboardProgress();

      progress.render();

      expect(logOutput.length).toBeGreaterThan(0);
      expect(logOutput.some((line) => line.includes("Authentication"))).toBe(
        true,
      );
    });
  });
});
