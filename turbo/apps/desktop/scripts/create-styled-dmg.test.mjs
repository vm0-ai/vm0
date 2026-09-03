import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStyledDmg,
  detachDmg,
  parseAttachDevice,
} from "./create-styled-dmg.mjs";

const originalPlatform = process.platform;
const temporaryDirectories = [];

function commandError(message, stderr = message) {
  const error = new Error(message);
  error.stderr = stderr;
  return error;
}

async function retainedDmgTempDirectories(keepDmgTemp) {
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), "desktop-dmg-cleanup-test-"),
  );
  temporaryDirectories.push(fixtureDirectory);
  const appPath = join(fixtureDirectory, "Okou.app");
  const backgroundSvg = join(fixtureDirectory, "background.svg");
  const emptyPath = join(fixtureDirectory, "empty-path");
  await mkdir(appPath);
  await mkdir(emptyPath);
  await writeFile(backgroundSvg, "<svg></svg>");

  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
  vi.stubEnv("TMPDIR", fixtureDirectory);
  vi.stubEnv("PATH", emptyPath);
  vi.stubEnv("OKOU_DESKTOP_KEEP_DMG_TEMP", keepDmgTemp);

  await expect(
    createStyledDmg({
      appPath,
      backgroundSvg,
      outPath: join(fixtureDirectory, "Okou.dmg"),
      volumeName: "Okou",
    }),
  ).rejects.toThrow();

  return (await readdir(fixtureDirectory)).filter((entry) =>
    entry.startsWith("desktop-dmg-"),
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("createStyledDmg cleanup", () => {
  it('keeps the temporary directory on failure only for the exact value "true"', async () => {
    expect(await retainedDmgTempDirectories("true")).toHaveLength(1);
  });

  it.each([undefined, "false", "TRUE", "1", ""])(
    "removes the temporary directory on failure when the switch is %s",
    async (keepDmgTemp) => {
      expect(await retainedDmgTempDirectories(keepDmgTemp)).toHaveLength(0);
    },
  );
});

describe("create-styled-dmg helpers", () => {
  it("parses the attached whole disk device from hdiutil attach output", () => {
    const output = [
      "/dev/disk7\tGUID_partition_scheme",
      "/dev/disk7s1\tEFI",
      "/dev/disk7s2\tApple_HFS\t/private/tmp/okou-dmg/mount",
    ].join("\n");

    expect(parseAttachDevice(output, "/private/tmp/okou-dmg/mount")).toBe(
      "/dev/disk7",
    );
  });

  it("falls back to the first hdiutil disk when the mount line is absent", () => {
    const output = [
      "/dev/disk8\tGUID_partition_scheme",
      "/dev/disk8s1\tEFI",
      "/dev/disk8s2\tApple_HFS",
    ].join("\n");

    expect(parseAttachDevice(output, "/tmp/missing-mount")).toBe("/dev/disk8");
  });

  it("retries resource-busy detach failures and treats already-detached output as success", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wait = vi.fn();
    let detachCalls = 0;
    const runCommand = vi.fn(async (command, args) => {
      if (command === "sync") {
        return "";
      }
      if (command === "hdiutil" && args[0] === "detach") {
        detachCalls += 1;
        if (detachCalls === 1) {
          throw commandError(
            "Command failed: hdiutil detach /dev/disk4",
            'hdiutil: couldn\'t eject "disk4" - Resource busy',
          );
        }
        throw commandError(
          "Command failed: hdiutil detach /dev/disk4",
          "hdiutil: detach failed - No such file or directory",
        );
      }
      return "";
    });

    await expect(
      detachDmg({
        mountPath: "/tmp/okou-dmg/mount",
        device: "/dev/disk4",
        runCommand,
        wait,
        retryDelaysMs: [10],
      }),
    ).resolves.toBeUndefined();

    expect(detachCalls).toBe(2);
    expect(wait).toHaveBeenCalledWith(10);
    expect(runCommand).toHaveBeenCalledWith("sync", [], { silent: true });
  });

  it("uses force detach after normal retries are exhausted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runCommand = vi.fn(async (command, args) => {
      if (command === "sync") {
        return "";
      }
      if (command === "hdiutil" && args.join(" ") === "detach /dev/disk4") {
        throw commandError(
          "Command failed: hdiutil detach /dev/disk4",
          'hdiutil: couldn\'t eject "disk4" - Resource busy',
        );
      }
      return "";
    });

    await detachDmg({
      mountPath: "/tmp/okou-dmg/mount",
      device: "/dev/disk4",
      runCommand,
      wait: vi.fn(),
      retryDelaysMs: [],
    });

    expect(runCommand).toHaveBeenCalledWith("hdiutil", [
      "detach",
      "-force",
      "/dev/disk4",
    ]);
  });
});
