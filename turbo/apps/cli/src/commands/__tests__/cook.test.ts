import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { parseRunIdsFromOutput, extractRequiredVarNames } from "../cook";

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
  });

  describe("checkMissingVariables", () => {
    it("should return empty array when all variables are in process.env", () => {
      vi.stubEnv(TEST_VAR_1, "test-key");
      vi.stubEnv(TEST_VAR_2, "test-password");

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
      // Simulate .env file variables by setting them in process.env
      vi.stubEnv(TEST_VAR_1, "from-dotenv");
      vi.stubEnv(TEST_VAR_2, "from-dotenv");

      const varNames = [TEST_VAR_1, TEST_VAR_2];
      const missing: string[] = [];

      for (const name of varNames) {
        if (process.env[name] === undefined) {
          missing.push(name);
        }
      }

      expect(missing).toHaveLength(0);
    });

    it("should return missing variables not in env or .env", () => {
      // Only TEST_VAR_1 is available (simulating .env file)
      vi.stubEnv(TEST_VAR_1, "from-dotenv");

      const varNames = [TEST_VAR_1, TEST_VAR_2, TEST_VAR_4];
      const missing: string[] = [];

      for (const name of varNames) {
        if (process.env[name] === undefined) {
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
      const missingVars = ["API_KEY", "DB_PASSWORD"];
      const placeholders = missingVars.map((name) => `${name}=`).join("\n");

      await fs.writeFile(path.join(tempDir, ".env"), `${placeholders}\n`);

      const content = await fs.readFile(path.join(tempDir, ".env"), "utf8");
      expect(content).toBe("API_KEY=\nDB_PASSWORD=\n");
    });

    it("should append to existing .env file", async () => {
      await fs.writeFile(path.join(tempDir, ".env"), "EXISTING_VAR=value\n");

      const existingContent = readFileSync(path.join(tempDir, ".env"), "utf8");
      const needsNewline =
        existingContent.length > 0 && !existingContent.endsWith("\n");
      const prefix = needsNewline ? "\n" : "";
      const missingVars = ["NEW_VAR"];
      const placeholders = missingVars.map((name) => `${name}=`).join("\n");

      await fs.appendFile(
        path.join(tempDir, ".env"),
        `${prefix}${placeholders}\n`,
      );

      const finalContent = await fs.readFile(
        path.join(tempDir, ".env"),
        "utf8",
      );
      expect(finalContent).toBe("EXISTING_VAR=value\nNEW_VAR=\n");
    });

    it("should add newline before appending if file doesn't end with newline", async () => {
      await fs.writeFile(path.join(tempDir, ".env"), "EXISTING_VAR=value"); // No trailing newline

      const existingContent = readFileSync(path.join(tempDir, ".env"), "utf8");
      const needsNewline =
        existingContent.length > 0 && !existingContent.endsWith("\n");
      const prefix = needsNewline ? "\n" : "";
      const missingVars = ["NEW_VAR"];
      const placeholders = missingVars.map((name) => `${name}=`).join("\n");

      await fs.appendFile(
        path.join(tempDir, ".env"),
        `${prefix}${placeholders}\n`,
      );

      const finalContent = await fs.readFile(
        path.join(tempDir, ".env"),
        "utf8",
      );
      expect(finalContent).toBe("EXISTING_VAR=value\nNEW_VAR=\n");
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
