import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("common", () => {
  describe("validateConfig", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
    });

    it("should throw when VM0_WORKING_DIR is not set", async () => {
      const originalWorkingDir = process.env.VM0_WORKING_DIR;
      delete process.env.VM0_WORKING_DIR;

      try {
        const { validateConfig } = await import("../src/lib/common");
        expect(() => validateConfig()).toThrow(
          "VM0_WORKING_DIR is required but not set",
        );
      } finally {
        if (originalWorkingDir !== undefined) {
          process.env.VM0_WORKING_DIR = originalWorkingDir;
        }
      }
    });

    it("should throw when VM0_WORKING_DIR is empty string", async () => {
      const originalWorkingDir = process.env.VM0_WORKING_DIR;
      process.env.VM0_WORKING_DIR = "";

      try {
        const { validateConfig } = await import("../src/lib/common");
        expect(() => validateConfig()).toThrow(
          "VM0_WORKING_DIR is required but not set",
        );
      } finally {
        if (originalWorkingDir !== undefined) {
          process.env.VM0_WORKING_DIR = originalWorkingDir;
        } else {
          delete process.env.VM0_WORKING_DIR;
        }
      }
    });

    it("should return true when VM0_WORKING_DIR is set", async () => {
      const originalWorkingDir = process.env.VM0_WORKING_DIR;
      process.env.VM0_WORKING_DIR = "/some/path";

      try {
        const { validateConfig } = await import("../src/lib/common");
        expect(validateConfig()).toBe(true);
      } finally {
        if (originalWorkingDir !== undefined) {
          process.env.VM0_WORKING_DIR = originalWorkingDir;
        } else {
          delete process.env.VM0_WORKING_DIR;
        }
      }
    });
  });

  describe("recordSandboxOp", () => {
    let tempDir: string;
    let originalRunId: string | undefined;

    beforeEach(() => {
      vi.resetModules();
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "common-test-"));
      originalRunId = process.env.VM0_RUN_ID;
      // Set a unique run ID for testing
      process.env.VM0_RUN_ID = "test-run-123";
    });

    afterEach(() => {
      vi.resetModules();
      if (originalRunId !== undefined) {
        process.env.VM0_RUN_ID = originalRunId;
      } else {
        delete process.env.VM0_RUN_ID;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should write operation entry to JSONL file", async () => {
      // Clean up any existing file from previous test runs
      const logFile = "/tmp/vm0-sandbox-ops-test-run-123.jsonl";
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }

      const { recordSandboxOp } = await import("../src/lib/common");

      recordSandboxOp("test_operation", 100, true);

      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]!);
      expect(entry.action_type).toBe("test_operation");
      expect(entry.duration_ms).toBe(100);
      expect(entry.success).toBe(true);
      expect(entry.ts).toBeDefined();
      expect(entry.error).toBeUndefined();

      // Clean up
      fs.unlinkSync(logFile);
    });

    it("should include error field when provided", async () => {
      const logFile = "/tmp/vm0-sandbox-ops-test-run-123.jsonl";
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }

      const { recordSandboxOp } = await import("../src/lib/common");

      recordSandboxOp("failed_operation", 50, false, "Something went wrong");

      const content = fs.readFileSync(logFile, "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.action_type).toBe("failed_operation");
      expect(entry.duration_ms).toBe(50);
      expect(entry.success).toBe(false);
      expect(entry.error).toBe("Something went wrong");

      // Clean up
      fs.unlinkSync(logFile);
    });

    it("should append multiple entries", async () => {
      const logFile = "/tmp/vm0-sandbox-ops-test-run-123.jsonl";
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }

      const { recordSandboxOp } = await import("../src/lib/common");

      recordSandboxOp("op1", 10, true);
      recordSandboxOp("op2", 20, true);
      recordSandboxOp("op3", 30, false, "error");

      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3);

      const entry1 = JSON.parse(lines[0]!);
      const entry2 = JSON.parse(lines[1]!);
      const entry3 = JSON.parse(lines[2]!);

      expect(entry1.action_type).toBe("op1");
      expect(entry2.action_type).toBe("op2");
      expect(entry3.action_type).toBe("op3");

      // Clean up
      fs.unlinkSync(logFile);
    });

    it("should write valid ISO timestamp", async () => {
      const logFile = "/tmp/vm0-sandbox-ops-test-run-123.jsonl";
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }

      const beforeTime = new Date();
      const { recordSandboxOp } = await import("../src/lib/common");
      recordSandboxOp("timestamp_test", 5, true);
      const afterTime = new Date();

      const content = fs.readFileSync(logFile, "utf-8");
      const entry = JSON.parse(content.trim());

      // Verify timestamp is valid ISO format and within expected range
      const entryTime = new Date(entry.ts);
      expect(entryTime.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(entryTime.getTime()).toBeLessThanOrEqual(afterTime.getTime());

      // Clean up
      fs.unlinkSync(logFile);
    });
  });

  describe("URL construction", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
    });

    it("should construct webhook URLs from API_URL", async () => {
      const originalApiUrl = process.env.VM0_API_URL;
      process.env.VM0_API_URL = "https://api.example.com";

      try {
        const {
          WEBHOOK_URL,
          CHECKPOINT_URL,
          COMPLETE_URL,
          HEARTBEAT_URL,
          TELEMETRY_URL,
        } = await import("../src/lib/common");

        expect(WEBHOOK_URL).toBe(
          "https://api.example.com/api/webhooks/agent/events",
        );
        expect(CHECKPOINT_URL).toBe(
          "https://api.example.com/api/webhooks/agent/checkpoints",
        );
        expect(COMPLETE_URL).toBe(
          "https://api.example.com/api/webhooks/agent/complete",
        );
        expect(HEARTBEAT_URL).toBe(
          "https://api.example.com/api/webhooks/agent/heartbeat",
        );
        expect(TELEMETRY_URL).toBe(
          "https://api.example.com/api/webhooks/agent/telemetry",
        );
      } finally {
        if (originalApiUrl !== undefined) {
          process.env.VM0_API_URL = originalApiUrl;
        } else {
          delete process.env.VM0_API_URL;
        }
      }
    });

    it("should handle empty API_URL gracefully", async () => {
      const originalApiUrl = process.env.VM0_API_URL;
      delete process.env.VM0_API_URL;

      try {
        const { WEBHOOK_URL } = await import("../src/lib/common");
        expect(WEBHOOK_URL).toBe("/api/webhooks/agent/events");
      } finally {
        if (originalApiUrl !== undefined) {
          process.env.VM0_API_URL = originalApiUrl;
        }
      }
    });
  });

  describe("file path construction", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
    });

    it("should include RUN_ID in file paths", async () => {
      const originalRunId = process.env.VM0_RUN_ID;
      process.env.VM0_RUN_ID = "unique-run-456";

      try {
        const {
          SESSION_ID_FILE,
          EVENT_ERROR_FLAG,
          SYSTEM_LOG_FILE,
          AGENT_LOG_FILE,
          METRICS_LOG_FILE,
        } = await import("../src/lib/common");

        expect(SESSION_ID_FILE).toBe("/tmp/vm0-session-unique-run-456.txt");
        expect(EVENT_ERROR_FLAG).toBe("/tmp/vm0-event-error-unique-run-456");
        expect(SYSTEM_LOG_FILE).toBe("/tmp/vm0-main-unique-run-456.log");
        expect(AGENT_LOG_FILE).toBe("/tmp/vm0-agent-unique-run-456.log");
        expect(METRICS_LOG_FILE).toBe("/tmp/vm0-metrics-unique-run-456.jsonl");
      } finally {
        if (originalRunId !== undefined) {
          process.env.VM0_RUN_ID = originalRunId;
        } else {
          delete process.env.VM0_RUN_ID;
        }
      }
    });
  });
});
