import { afterEach, describe, expect, it, vi } from "vitest";

import { detachDmg, parseAttachDevice } from "./create-styled-dmg.mjs";

function commandError(message, stderr = message) {
  const error = new Error(message);
  error.stderr = stderr;
  return error;
}

describe("create-styled-dmg helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
