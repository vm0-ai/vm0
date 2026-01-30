import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWelcomeBox, renderOnboardWelcome } from "../welcome-box.js";

describe("welcome-box", () => {
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

  describe("renderWelcomeBox", () => {
    it("should render a box with borders", () => {
      renderWelcomeBox(["Hello"]);

      expect(logOutput.length).toBe(3);
      expect(logOutput[0]).toContain("┌");
      expect(logOutput[0]).toContain("┐");
      expect(logOutput[1]).toContain("│");
      expect(logOutput[2]).toContain("└");
      expect(logOutput[2]).toContain("┘");
    });

    it("should include the text content", () => {
      renderWelcomeBox(["Test Message"]);

      expect(logOutput[1]).toContain("Test Message");
    });

    it("should handle multiple lines", () => {
      renderWelcomeBox(["Line 1", "Line 2", "Line 3"]);

      expect(logOutput.length).toBe(5);
      expect(logOutput[1]).toContain("Line 1");
      expect(logOutput[2]).toContain("Line 2");
      expect(logOutput[3]).toContain("Line 3");
    });

    it("should render with custom width", () => {
      renderWelcomeBox(["Hi"], 20);

      const topBorder = logOutput[0];
      expect(topBorder).toContain("─".repeat(18));
    });
  });

  describe("renderOnboardWelcome", () => {
    it("should render the default welcome message", () => {
      renderOnboardWelcome();

      const output = logOutput.join("\n");
      expect(output).toContain("Welcome to VM0!");
      expect(output).toContain(
        "Build agentic workflows using natural language.",
      );
    });
  });
});
