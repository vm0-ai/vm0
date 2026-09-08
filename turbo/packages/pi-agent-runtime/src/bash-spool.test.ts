import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const scenarios = [
  "slow-32-stdout",
  "slow-64-stdout",
  "slow-32-stderr",
  "slow-64-stderr",
  "slow-32-mixed",
  "slow-64-mixed",
  "exit",
  "quiet",
  "abort",
  "timeout",
  "flush-abort",
  "flush-timeout",
  "open-error",
  "write-error",
  "premature-close",
  "spawn-error",
  "semantics",
  "compatibility",
  "accumulator",
  "drain-abort",
  "flush-write-error",
];

describe("installed official Pi Bash spool contract", () => {
  it.each(scenarios)(
    "%s",
    async (scenario) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL("./test-fixtures/bash-spool.mjs", import.meta.url),
          ),
          scenario,
        ],
        { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      );
      expect(stderr).toBe("");
      expect(stdout).toContain(`"scenario":"${scenario}"`);
    },
    35_000,
  );
});
