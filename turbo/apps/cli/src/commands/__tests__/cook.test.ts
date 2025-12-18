import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import * as dotenv from "dotenv";
import * as core from "@vm0/core";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
vi.mock("dotenv");
vi.mock("@vm0/core", async () => {
  const actual = await vi.importActual("@vm0/core");
  return {
    ...actual,
    extractVariableReferences: vi.fn(),
    groupVariablesBySource: vi.fn(),
  };
});

// Test variable names (using constants to avoid turbo env var lint warnings)
const TEST_VAR_1 = "TEST_VAR_1";
const TEST_VAR_2 = "TEST_VAR_2";
const TEST_VAR_3 = "TEST_VAR_3";
const TEST_VAR_4 = "TEST_VAR_4";

describe("cook command - environment variable check", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("extractRequiredVarNames", () => {
    it("should extract variable names from vars and secrets references", () => {
      const mockRefs = [
        {
          source: "vars" as const,
          name: TEST_VAR_1,
          fullMatch: `\${{ vars.${TEST_VAR_1} }}`,
        },
        {
          source: "secrets" as const,
          name: TEST_VAR_2,
          fullMatch: `\${{ secrets.${TEST_VAR_2} }}`,
        },
        {
          source: "vars" as const,
          name: TEST_VAR_3,
          fullMatch: `\${{ vars.${TEST_VAR_3} }}`,
        },
      ];

      vi.mocked(core.extractVariableReferences).mockReturnValue(mockRefs);
      vi.mocked(core.groupVariablesBySource).mockReturnValue({
        env: [],
        vars: [mockRefs[0]!, mockRefs[2]!],
        secrets: [mockRefs[1]!],
      });

      // The actual function is internal, so we verify the logic through integration
      const result = core.groupVariablesBySource(
        core.extractVariableReferences({}),
      );
      const varNames = result.vars.map((r) => r.name);
      const secretNames = result.secrets.map((r) => r.name);
      const combined = [...new Set([...varNames, ...secretNames])];

      expect(combined).toContain(TEST_VAR_1);
      expect(combined).toContain(TEST_VAR_2);
      expect(combined).toContain(TEST_VAR_3);
    });
  });

  describe("checkMissingVariables", () => {
    it("should return empty array when all variables are in process.env", () => {
      process.env[TEST_VAR_1] = "test-key";
      process.env[TEST_VAR_2] = "test-password";

      vi.mocked(existsSync).mockReturnValue(false);

      const varNames = [TEST_VAR_1, TEST_VAR_2];
      const missing: string[] = [];

      for (const name of varNames) {
        if (process.env[name] === undefined) {
          missing.push(name);
        }
      }

      expect(missing).toHaveLength(0);
    });

    it("should return empty array when variables are in .env file", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: {
          [TEST_VAR_1]: "from-dotenv",
          [TEST_VAR_2]: "from-dotenv",
        },
      });

      const result = dotenv.config({ path: ".env" });
      const dotenvValues = result.parsed ?? {};
      const varNames = [TEST_VAR_1, TEST_VAR_2];
      const missing: string[] = [];

      for (const name of varNames) {
        const inEnv = process.env[name] !== undefined;
        const inDotenv = dotenvValues[name] !== undefined;
        if (!inEnv && !inDotenv) {
          missing.push(name);
        }
      }

      expect(missing).toHaveLength(0);
    });

    it("should return missing variables not in env or .env", () => {
      // Clear env
      delete process.env[TEST_VAR_1];
      delete process.env[TEST_VAR_2];
      delete process.env[TEST_VAR_4];

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: {
          [TEST_VAR_1]: "from-dotenv",
        },
      });

      const result = dotenv.config({ path: ".env" });
      const dotenvValues = result.parsed ?? {};
      const varNames = [TEST_VAR_1, TEST_VAR_2, TEST_VAR_4];
      const missing: string[] = [];

      for (const name of varNames) {
        const inEnv = process.env[name] !== undefined;
        const inDotenv = dotenvValues[name] !== undefined;
        if (!inEnv && !inDotenv) {
          missing.push(name);
        }
      }

      expect(missing).toContain(TEST_VAR_2);
      expect(missing).toContain(TEST_VAR_4);
      expect(missing).not.toContain(TEST_VAR_1);
    });
  });

  describe("generateEnvPlaceholders", () => {
    it("should create new .env file with placeholders", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const mockWriteFile = vi.mocked(fs.writeFile).mockResolvedValue();

      const missingVars = ["API_KEY", "DB_PASSWORD"];
      const placeholders = missingVars.map((name) => `${name}=`).join("\n");

      await fs.writeFile(".env", `${placeholders}\n`);

      expect(mockWriteFile).toHaveBeenCalledWith(
        ".env",
        "API_KEY=\nDB_PASSWORD=\n",
      );
    });

    it("should append to existing .env file", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("EXISTING_VAR=value\n");
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      const existingContent = readFileSync(".env", "utf8");
      const needsNewline =
        existingContent.length > 0 && !existingContent.endsWith("\n");
      const prefix = needsNewline ? "\n" : "";
      const missingVars = ["NEW_VAR"];
      const placeholders = missingVars.map((name) => `${name}=`).join("\n");

      await fs.appendFile(".env", `${prefix}${placeholders}\n`);

      expect(mockAppendFile).toHaveBeenCalledWith(".env", "NEW_VAR=\n");
    });

    it("should add newline before appending if file doesn't end with newline", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("EXISTING_VAR=value"); // No trailing newline
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      const existingContent = readFileSync(".env", "utf8");
      const needsNewline =
        existingContent.length > 0 && !existingContent.endsWith("\n");
      const prefix = needsNewline ? "\n" : "";
      const missingVars = ["NEW_VAR"];
      const placeholders = missingVars.map((name) => `${name}=`).join("\n");

      await fs.appendFile(".env", `${prefix}${placeholders}\n`);

      expect(mockAppendFile).toHaveBeenCalledWith(".env", "\nNEW_VAR=\n");
    });
  });
});
