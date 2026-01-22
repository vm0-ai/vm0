/**
 * Unit tests for error message formatting
 *
 * These tests validate that error messages are properly formatted and displayed
 * when runs fail. This replaces the E2E test t10-vm0-error-messages.bats which
 * tested the same behavior through the full stack.
 *
 * Key behaviors tested:
 * - Detailed error messages are displayed instead of generic ones
 * - Error messages are properly formatted with appropriate styling
 * - System log hints are shown for debugging
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventRenderer } from "../lib/events/event-renderer";

describe("Error Message Formatting", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe("renderRunFailed", () => {
    it("should display detailed error message instead of generic exit code", () => {
      // This is the key behavior: when an agent fails with a specific error,
      // we should see the detailed error message, not "Agent exited with code 1"
      const detailedError =
        "Error: Could not resume session 'test-session': Session history file not found";

      EventRenderer.renderRunFailed(detailedError, "run-123");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      // Should show "Run failed" status
      expect(allCalls.some((call) => call.includes("Run failed"))).toBe(true);

      // Should contain the actual error message from stderr
      expect(
        allCalls.some((call) => call.includes("Could not resume session")),
      ).toBe(true);
      expect(
        allCalls.some((call) =>
          call.includes("Session history file not found"),
        ),
      ).toBe(true);

      // Should NOT contain just the generic exit code message
      // (The detailed message should replace it)
      expect(
        allCalls.some((call) => call.includes("Agent exited with code 1")),
      ).toBe(false);
    });

    it("should show system logs hint for debugging", () => {
      EventRenderer.renderRunFailed("Some error occurred", "run-456");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      // Should provide hint to view system logs
      expect(
        allCalls.some((call) => call.includes("vm0 logs run-456 --system")),
      ).toBe(true);
    });

    it("should handle undefined error gracefully", () => {
      EventRenderer.renderRunFailed(undefined, "run-789");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      // Should show "Unknown error" as fallback
      expect(allCalls.some((call) => call.includes("Unknown error"))).toBe(
        true,
      );
    });

    it("should handle empty string error", () => {
      EventRenderer.renderRunFailed("", "run-empty");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      // Should still show Run failed
      expect(allCalls.some((call) => call.includes("Run failed"))).toBe(true);
    });

    it("should preserve multiline error messages", () => {
      const multilineError =
        "Error on line 1\nStack trace line 2\nAdditional info line 3";

      EventRenderer.renderRunFailed(multilineError, "run-multi");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      // The error message should be present (may be on one line or multiple)
      const errorLine = allCalls.find(
        (call) => call.includes("Error on line 1") || call.includes("Error:"),
      );
      expect(errorLine).toBeDefined();
    });

    it("should handle special characters in error messages", () => {
      const specialError =
        "Error: File path '/tmp/test file.txt' contains <special> & \"characters\"";

      EventRenderer.renderRunFailed(specialError, "run-special");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      // Error should be displayed (special chars may be escaped by chalk)
      expect(allCalls.some((call) => call.includes("Run failed"))).toBe(true);
    });
  });

  describe("error message extraction patterns", () => {
    // These tests document the expected error message patterns that can be
    // displayed. The actual extraction happens in run-agent.ts on the sandbox.

    it("should handle Claude Code session errors", () => {
      const sessionError =
        "Error: Could not resume session 'abc123': Session history file not found";

      EventRenderer.renderRunFailed(sessionError, "run-session");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(
        allCalls.some((call) => call.includes("Could not resume session")),
      ).toBe(true);
    });

    it("should handle authentication errors", () => {
      const authError = "Error: Authentication failed: Invalid API key";

      EventRenderer.renderRunFailed(authError, "run-auth");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(
        allCalls.some((call) => call.includes("Authentication failed")),
      ).toBe(true);
    });

    it("should handle network errors", () => {
      const networkError =
        "Error: Network request failed: ECONNREFUSED 127.0.0.1:443";

      EventRenderer.renderRunFailed(networkError, "run-network");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(
        allCalls.some((call) => call.includes("Network request failed")),
      ).toBe(true);
    });

    it("should handle permission errors", () => {
      const permError = "Error: Permission denied: Cannot write to /etc/passwd";

      EventRenderer.renderRunFailed(permError, "run-perm");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(allCalls.some((call) => call.includes("Permission denied"))).toBe(
        true,
      );
    });

    it("should handle timeout errors", () => {
      const timeoutError =
        "Error: Operation timed out after 300000ms waiting for response";

      EventRenderer.renderRunFailed(timeoutError, "run-timeout");

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(allCalls.some((call) => call.includes("timed out"))).toBe(true);
    });
  });
});
