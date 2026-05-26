import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createComputerUseNativeBackend } from "./computer-use-native";

async function createHelper(
  response: unknown,
): Promise<{ readonly dir: string; readonly helperPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath };
}

describe("computer use native backend", () => {
  it("reads permissions from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: { accessibility: true, screenRecording: false },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
      });

      await expect(backend.getPermissions()).resolves.toEqual({
        accessibility: true,
        screenRecording: false,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("requests accessibility permission through the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: { accessibility: true, screenRecording: true },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
      });

      await expect(backend.requestAccessibilityPermission()).resolves.toEqual({
        accessibility: true,
        screenRecording: true,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["app_not_found", "Unable to open Things: Unable to find application"],
    ["app_open_failed", "Unable to open Things"],
  ])("preserves %s helper failures", async (code, message) => {
    const helper = await createHelper({
      status: "failed",
      error: { code, message },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
      });

      await expect(backend.openApp("Things")).rejects.toMatchObject({
        code,
        message,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });
});
