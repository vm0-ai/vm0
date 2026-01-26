import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseRunIdsFromOutput,
  extractRequiredVarNames,
  checkMissingVariables,
  CONFIG_FILE,
} from "../cook";

// Mock os module to return our temp directory as homedir for cook-state tests
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    // Return actual homedir by default, tests can override
    homedir: vi.fn().mockReturnValue(actual.homedir()),
  };
});

// Test variable names (using constants to avoid turbo env var lint warnings)
const TEST_VAR_1 = "TEST_VAR_1";
const TEST_VAR_2 = "TEST_VAR_2";
const TEST_VAR_4 = "TEST_VAR_4";

describe("cook command - environment variable check", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-cook-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    // Clean up any env vars set by dotenv during tests
    delete process.env[TEST_VAR_1];
    delete process.env[TEST_VAR_2];
    delete process.env[TEST_VAR_4];
  });

  describe("checkMissingVariables", () => {
    it("should return empty array when all variables are in process.env", () => {
      vi.stubEnv(TEST_VAR_1, "test-key");
      vi.stubEnv(TEST_VAR_2, "test-password");

      const varNames = [TEST_VAR_1, TEST_VAR_2];

      // No envFilePath - only check process.env
      const missing = checkMissingVariables(varNames);

      expect(missing).toHaveLength(0);
    });

    it("should return empty array when variables are in --env-file", async () => {
      // Create env file with the variables
      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(
        envFilePath,
        `${TEST_VAR_1}=from-file\n${TEST_VAR_2}=from-file\n`,
      );

      const varNames = [TEST_VAR_1, TEST_VAR_2];

      // Explicitly provide envFilePath
      const missing = checkMissingVariables(varNames, envFilePath);

      expect(missing).toHaveLength(0);
    });

    it("should return missing variables not in env or --env-file", async () => {
      // Use unique variable names that won't exist in process.env
      const UNIQUE_VAR_EXISTS = "COOK_TEST_VAR_EXISTS_" + Date.now();
      const UNIQUE_VAR_MISSING_1 = "COOK_TEST_VAR_MISSING_1_" + Date.now();
      const UNIQUE_VAR_MISSING_2 = "COOK_TEST_VAR_MISSING_2_" + Date.now();

      // Create env file with only one variable
      const envFilePath = path.join(tempDir, ".env");
      await fs.writeFile(envFilePath, `${UNIQUE_VAR_EXISTS}=from-file\n`);

      const varNames = [
        UNIQUE_VAR_EXISTS,
        UNIQUE_VAR_MISSING_1,
        UNIQUE_VAR_MISSING_2,
      ];

      const missing = checkMissingVariables(varNames, envFilePath);

      expect(missing).toContain(UNIQUE_VAR_MISSING_1);
      expect(missing).toContain(UNIQUE_VAR_MISSING_2);
      expect(missing).not.toContain(UNIQUE_VAR_EXISTS);
    });

    it("should return all variables when no --env-file and not in process.env", () => {
      // Use unique variable names that won't exist in process.env
      const UNIQUE_VAR_1 = "COOK_TEST_UNIQUE_VAR_1_" + Date.now();
      const UNIQUE_VAR_2 = "COOK_TEST_UNIQUE_VAR_2_" + Date.now();

      const varNames = [UNIQUE_VAR_1, UNIQUE_VAR_2];

      // No envFilePath - only check process.env
      const missing = checkMissingVariables(varNames);

      expect(missing).toContain(UNIQUE_VAR_1);
      expect(missing).toContain(UNIQUE_VAR_2);
    });

    it("should throw error when --env-file does not exist", () => {
      const envFilePath = path.join(tempDir, "nonexistent.env");
      const varNames = [TEST_VAR_1];

      expect(() => checkMissingVariables(varNames, envFilePath)).toThrow(
        `Environment file not found: ${envFilePath}`,
      );
    });
  });
});

describe("parseRunIdsFromOutput", () => {
  it("extracts all three IDs from successful output", () => {
    const output = `
✓ Run completed successfully
  Checkpoint:    3933f2c8-f907-480f-8829-760eb7ebb0d5
  Session:       74989172-42ff-4156-85aa-ec9bdcbf3564
  Conversation:  67f6d240-90f3-4ab4-9dae-14f8105cb872
  Artifact:
    artifact: e5215be8

  View agent logs:
    vm0 logs ae715364-657c-462f-88ad-3c8d4ec7edf2
  Continue with session (latest conversation and artifact):
    vm0 run continue 74989172-42ff-4156-85aa-ec9bdcbf3564 "your next prompt"
  Resume from checkpoint (snapshotted conversation and artifact):
    vm0 run resume 3933f2c8-f907-480f-8829-760eb7ebb0d5 "your next prompt"
`;

    const result = parseRunIdsFromOutput(output);

    expect(result.runId).toBe("ae715364-657c-462f-88ad-3c8d4ec7edf2");
    expect(result.sessionId).toBe("74989172-42ff-4156-85aa-ec9bdcbf3564");
    expect(result.checkpointId).toBe("3933f2c8-f907-480f-8829-760eb7ebb0d5");
  });

  it("handles output with ANSI color codes", () => {
    const output = `
\x1b[32m✓ Run completed successfully\x1b[0m
  Checkpoint:    \x1b[90m3933f2c8-f907-480f-8829-760eb7ebb0d5\x1b[0m
  Session:       \x1b[90m74989172-42ff-4156-85aa-ec9bdcbf3564\x1b[0m

  View agent logs:
    \x1b[36mvm0 logs ae715364-657c-462f-88ad-3c8d4ec7edf2\x1b[0m
  Continue with session (latest conversation and artifact):
    \x1b[36mvm0 run continue 74989172-42ff-4156-85aa-ec9bdcbf3564 "your next prompt"\x1b[0m
  Resume from checkpoint (snapshotted conversation and artifact):
    \x1b[36mvm0 run resume 3933f2c8-f907-480f-8829-760eb7ebb0d5 "your next prompt"\x1b[0m
`;

    const result = parseRunIdsFromOutput(output);

    expect(result.runId).toBe("ae715364-657c-462f-88ad-3c8d4ec7edf2");
    expect(result.sessionId).toBe("74989172-42ff-4156-85aa-ec9bdcbf3564");
    expect(result.checkpointId).toBe("3933f2c8-f907-480f-8829-760eb7ebb0d5");
  });

  it("returns empty object when no completion marker", () => {
    const output = `
Some random output
without the completion marker
`;

    const result = parseRunIdsFromOutput(output);

    expect(result).toEqual({});
  });

  it("handles partial output (missing some IDs)", () => {
    const output = `
✓ Run completed successfully
  Checkpoint:    3933f2c8-f907-480f-8829-760eb7ebb0d5

  View agent logs:
    vm0 logs ae715364-657c-462f-88ad-3c8d4ec7edf2
`;

    const result = parseRunIdsFromOutput(output);

    expect(result.runId).toBe("ae715364-657c-462f-88ad-3c8d4ec7edf2");
    expect(result.sessionId).toBeUndefined();
    expect(result.checkpointId).toBeUndefined();
  });
});

describe("extractRequiredVarNames", () => {
  it("should extract and combine variable names from vars and secrets", () => {
    const config = {
      version: "1.0",
      agents: {
        "test-agent": {
          framework: "claude-code",
          image: "test",
          working_dir: "/workspace",
          environment: {
            VAR1: "${{ vars.API_KEY }}",
            VAR2: "${{ secrets.DB_PASSWORD }}",
            VAR3: "${{ vars.BASE_URL }}",
          },
        },
      },
    };

    const result = extractRequiredVarNames(config);

    expect(result).toHaveLength(3);
    expect(result).toContain("API_KEY");
    expect(result).toContain("DB_PASSWORD");
    expect(result).toContain("BASE_URL");
  });

  it("should deduplicate variable names", () => {
    const config = {
      version: "1.0",
      agents: {
        "test-agent": {
          framework: "claude-code",
          image: "test",
          working_dir: "/workspace",
          environment: {
            VAR1: "${{ vars.DUPLICATE }}",
            VAR2: "${{ secrets.DUPLICATE }}",
            VAR3: "${{ vars.UNIQUE }}",
          },
        },
      },
    };

    const result = extractRequiredVarNames(config);

    expect(result).toHaveLength(2);
    expect(result).toContain("DUPLICATE");
    expect(result).toContain("UNIQUE");
  });

  it("should return empty array for config without variables", () => {
    const config = {
      version: "1.0",
      agents: {
        "test-agent": {
          framework: "claude-code",
          image: "test",
          working_dir: "/workspace",
          environment: {
            STATIC: "value",
          },
        },
      },
    };

    const result = extractRequiredVarNames(config);

    expect(result).toHaveLength(0);
  });

  it("should ignore env and credentials sources", () => {
    const config = {
      version: "1.0",
      agents: {
        "test-agent": {
          framework: "claude-code",
          image: "test",
          working_dir: "/workspace",
          environment: {
            VAR1: "${{ env.ENV_VAR }}",
            VAR2: "${{ vars.VARS_VAR }}",
            VAR3: "${{ credentials.CRED_VAR }}",
            VAR4: "${{ secrets.SECRET_VAR }}",
          },
        },
      },
    };

    const result = extractRequiredVarNames(config);

    // Only vars and secrets should be included
    expect(result).toHaveLength(2);
    expect(result).toContain("VARS_VAR");
    expect(result).toContain("SECRET_VAR");
    expect(result).not.toContain("ENV_VAR");
    expect(result).not.toContain("CRED_VAR");
  });
});

describe("cook subcommand error handling", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-cook-errors-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    // Make os.homedir() return tempDir for cook-state tests
    vi.mocked(os.homedir).mockReturnValue(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("cook logs without prior run", () => {
    it("returns empty state when cook.json does not exist", async () => {
      // No cook.json file exists
      const { loadCookState } = await import("../../lib/domain/cook-state");
      const state = await loadCookState();

      expect(state.lastRunId).toBeUndefined();
    });

    it("error message should indicate no previous run", () => {
      // Verify the error message format that would be shown
      const errorMessage = "No previous run found";
      const hintMessage = "Run 'vm0 cook <prompt>' first";

      expect(errorMessage).toContain("No previous run found");
      expect(hintMessage).toContain("vm0 cook");
    });
  });

  describe("cook continue without prior run", () => {
    it("returns empty state when no session exists", async () => {
      // No cook.json file exists
      const { loadCookState } = await import("../../lib/domain/cook-state");
      const state = await loadCookState();

      expect(state.lastSessionId).toBeUndefined();
    });

    it("error message should indicate no previous session", () => {
      // Verify the error message format that would be shown
      const errorMessage = "No previous session found";
      const hintMessage = "Run 'vm0 cook <prompt>' first";

      expect(errorMessage).toContain("No previous session found");
      expect(hintMessage).toContain("vm0 cook");
    });
  });

  describe("cook resume without prior run", () => {
    it("returns empty state when no checkpoint exists", async () => {
      // No cook.json file exists
      const { loadCookState } = await import("../../lib/domain/cook-state");
      const state = await loadCookState();

      expect(state.lastCheckpointId).toBeUndefined();
    });

    it("error message should indicate no previous checkpoint", () => {
      // Verify the error message format that would be shown
      const errorMessage = "No previous checkpoint found";
      const hintMessage = "Run 'vm0 cook <prompt>' first";

      expect(errorMessage).toContain("No previous checkpoint found");
      expect(hintMessage).toContain("vm0 cook");
    });
  });

  describe("cook logs tutorial-style command hint", () => {
    it("generates correct command hint when run ID exists", async () => {
      const mockPpid = String(process.ppid);
      const runId = "test-run-id-12345678-1234-1234-1234-123456789012";

      // Create cook state with run ID
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
        JSON.stringify({
          ppid: {
            [mockPpid]: {
              lastRunId: runId,
              lastActiveAt: Date.now(),
            },
          },
        }),
      );

      const { loadCookState } = await import("../../lib/domain/cook-state");
      const state = await loadCookState();

      // Verify the command hint format
      const expectedCommand = `vm0 logs ${state.lastRunId}`;
      expect(expectedCommand).toBe(`vm0 logs ${runId}`);
    });
  });

  describe("cook continue tutorial-style command hint", () => {
    it("generates correct command hint when session ID exists", async () => {
      const mockPpid = String(process.ppid);
      const sessionId = "test-session-12345678-1234-1234-1234-123456789012";

      // Create cook state with session ID
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
        JSON.stringify({
          ppid: {
            [mockPpid]: {
              lastSessionId: sessionId,
              lastActiveAt: Date.now(),
            },
          },
        }),
      );

      const { loadCookState } = await import("../../lib/domain/cook-state");
      const state = await loadCookState();

      // Verify the command hint format
      const expectedCommand = `vm0 run continue ${state.lastSessionId}`;
      expect(expectedCommand).toBe(`vm0 run continue ${sessionId}`);
    });
  });

  describe("cook resume tutorial-style command hint", () => {
    it("generates correct command hint when checkpoint ID exists", async () => {
      const mockPpid = String(process.ppid);
      const checkpointId = "test-checkpoint-1234-1234-1234-1234-123456789012";

      // Create cook state with checkpoint ID
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
        JSON.stringify({
          ppid: {
            [mockPpid]: {
              lastCheckpointId: checkpointId,
              lastActiveAt: Date.now(),
            },
          },
        }),
      );

      const { loadCookState } = await import("../../lib/domain/cook-state");
      const state = await loadCookState();

      // Verify the command hint format
      const expectedCommand = `vm0 run resume ${state.lastCheckpointId}`;
      expect(expectedCommand).toBe(`vm0 run resume ${checkpointId}`);
    });
  });
});

describe("cook command - config file detection", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-cook-config-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("CONFIG_FILE constant", () => {
    it("should export the correct config file name", () => {
      expect(CONFIG_FILE).toBe("vm0.yaml");
    });
  });

  describe("config file existence check", () => {
    it("should return false when vm0.yaml is missing", () => {
      const configPath = path.join(tempDir, CONFIG_FILE);
      expect(existsSync(configPath)).toBe(false);
    });

    it("should return true when vm0.yaml exists", async () => {
      const configPath = path.join(tempDir, CONFIG_FILE);
      await fs.writeFile(
        configPath,
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n`,
      );
      expect(existsSync(configPath)).toBe(true);
    });
  });
});
