import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readOrCreateComputerUseInstallationId } from "./desktop-computer-use-installation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createPreferencesPath(): Promise<{
  readonly directory: string;
  readonly preferencesPath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm0-desktop-"));
  return {
    directory,
    preferencesPath: path.join(directory, "desktop-preferences.json"),
  };
}

describe("readOrCreateComputerUseInstallationId", () => {
  it("persists a generated installation id and preserves other preferences", async () => {
    const { directory, preferencesPath } = await createPreferencesPath();
    try {
      await writeFile(
        preferencesPath,
        `${JSON.stringify({ keepAwakeEnabled: true }, null, 2)}\n`,
        "utf8",
      );

      const first = readOrCreateComputerUseInstallationId(preferencesPath);
      const second = readOrCreateComputerUseInstallationId(preferencesPath);

      expect(first).toMatch(UUID_RE);
      expect(second).toBe(first);
      expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject(
        {
          computerUseInstallationId: first,
          keepAwakeEnabled: true,
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
