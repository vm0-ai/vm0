import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("stages only verified runtime archives and validates packaged integrity across signing", () => {
  const result = spawnSync(
    "python3",
    [path.join(__dirname, "../scripts/test-cua-distribution.py")],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
});
