import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { loadValues, handleGenericRunError } from "../shared";
import { ApiRequestError } from "../../../lib/api/core/client-factory";

// Test variable names (using unique prefixes to avoid env collisions)
const TEST_VAR_1 = "SHARED_TEST_VAR_1";
const TEST_VAR_2 = "SHARED_TEST_VAR_2";
const TEST_VAR_3 = "SHARED_TEST_VAR_3";

describe("loadValues", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-shared-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    // Clean up any env vars
    delete process.env[TEST_VAR_1];
    delete process.env[TEST_VAR_2];
    delete process.env[TEST_VAR_3];
  });

  describe("priority order: CLI > file > env", () => {
    it("CLI values take highest priority over file and env", async () => {
      // Set up env var
      vi.stubEnv(TEST_VAR_1, "from-env");

      // Create env file
      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(envFilePath, `${TEST_VAR_1}=from-file\n`);

      // CLI value should win
      const cliValues = { [TEST_VAR_1]: "from-cli" };
      const result = loadValues(cliValues, [TEST_VAR_1], envFilePath);

      expect(result?.[TEST_VAR_1]).toBe("from-cli");
    });

    it("file values override env vars", async () => {
      // Set up env var
      vi.stubEnv(TEST_VAR_1, "from-env");

      // Create env file
      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(envFilePath, `${TEST_VAR_1}=from-file\n`);

      // File value should override env
      const result = loadValues({}, [TEST_VAR_1], envFilePath);

      expect(result?.[TEST_VAR_1]).toBe("from-file");
    });

    it("env vars used as fallback when no file provided", () => {
      // Set up env var
      vi.stubEnv(TEST_VAR_1, "from-env");

      // No envFilePath provided
      const result = loadValues({}, [TEST_VAR_1]);

      expect(result?.[TEST_VAR_1]).toBe("from-env");
    });

    it("env vars used for keys not in file", async () => {
      // Set up env vars
      vi.stubEnv(TEST_VAR_1, "from-env");
      vi.stubEnv(TEST_VAR_2, "from-env");

      // Create env file with only one variable
      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(envFilePath, `${TEST_VAR_1}=from-file\n`);

      const result = loadValues({}, [TEST_VAR_1, TEST_VAR_2], envFilePath);

      // VAR_1 from file, VAR_2 from env
      expect(result?.[TEST_VAR_1]).toBe("from-file");
      expect(result?.[TEST_VAR_2]).toBe("from-env");
    });
  });

  describe("without --env-file", () => {
    it("only loads from CLI and env when no envFilePath", () => {
      vi.stubEnv(TEST_VAR_1, "from-env");

      const cliValues = { [TEST_VAR_2]: "from-cli" };
      const result = loadValues(cliValues, [TEST_VAR_1, TEST_VAR_2]);

      expect(result?.[TEST_VAR_1]).toBe("from-env");
      expect(result?.[TEST_VAR_2]).toBe("from-cli");
    });

    it("returns undefined when no values found and no envFilePath", () => {
      const UNIQUE_VAR = "UNIQUE_VAR_" + Date.now();
      const result = loadValues({}, [UNIQUE_VAR]);

      expect(result).toBeUndefined();
    });
  });

  describe("with --env-file", () => {
    it("loads values from specified file", async () => {
      const envFilePath = path.join(tempDir, "custom.env");
      await fs.writeFile(envFilePath, `${TEST_VAR_1}=custom-value\n`);

      const result = loadValues({}, [TEST_VAR_1], envFilePath);

      expect(result?.[TEST_VAR_1]).toBe("custom-value");
    });

    it("throws error when file does not exist", () => {
      const envFilePath = path.join(tempDir, "nonexistent.env");

      expect(() => loadValues({}, [TEST_VAR_1], envFilePath)).toThrow(
        `Environment file not found: ${envFilePath}`,
      );
    });

    it("handles empty file gracefully", async () => {
      vi.stubEnv(TEST_VAR_1, "from-env");

      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(envFilePath, "");

      const result = loadValues({}, [TEST_VAR_1], envFilePath);

      // Falls back to env
      expect(result?.[TEST_VAR_1]).toBe("from-env");
    });
  });

  describe("edge cases", () => {
    it("returns CLI values even if configNames is empty", () => {
      const cliValues = { [TEST_VAR_1]: "cli-value" };
      const result = loadValues(cliValues, []);

      expect(result?.[TEST_VAR_1]).toBe("cli-value");
    });

    it("returns undefined when cliValues empty and configNames empty", () => {
      const result = loadValues({}, []);

      expect(result).toBeUndefined();
    });

    it("only loads keys that are in configNames from file", async () => {
      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(
        envFilePath,
        `${TEST_VAR_1}=value1\n${TEST_VAR_2}=value2\n${TEST_VAR_3}=value3\n`,
      );

      // Only ask for VAR_1 and VAR_2
      const result = loadValues({}, [TEST_VAR_1, TEST_VAR_2], envFilePath);

      expect(result?.[TEST_VAR_1]).toBe("value1");
      expect(result?.[TEST_VAR_2]).toBe("value2");
      expect(result?.[TEST_VAR_3]).toBeUndefined();
    });
  });
});

describe("handleGenericRunError", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("shows run list/kill hints for concurrent run limit error", () => {
    const error = new ApiRequestError(
      "You have reached the concurrent agent run limit.",
      "concurrent_run_limit_exceeded",
    );

    handleGenericRunError(error, "Run");

    // Check that the error message is shown
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run failed"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("concurrent agent run limit"),
    );

    // Check that the hints are shown
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("vm0 run list"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("vm0 run kill"),
    );
  });

  it("shows generic error for non-concurrent-limit errors", () => {
    const error = new Error("Some other error");

    handleGenericRunError(error, "Resume");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Resume failed"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Some other error"),
    );

    // Should NOT show run list/kill hints
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("vm0 run list"),
    );
  });

  it("shows generic error for ApiRequestError with different code", () => {
    const error = new ApiRequestError("Resource not found", "NOT_FOUND");

    handleGenericRunError(error, "Continue");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Continue failed"),
    );

    // Should NOT show run list/kill hints
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("vm0 run list"),
    );
  });
});
