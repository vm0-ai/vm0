/**
 * Unit tests for list and clone commands
 *
 * These tests validate command configuration, help text, aliases, and argument definitions.
 * This replaces E2E tests that verified these behaviors through the full stack.
 *
 * Key behaviors tested:
 * - Command names and descriptions
 * - Command aliases (ls)
 * - Argument definitions (required vs optional)
 *
 * Note: Tests that require HTTP mocking and actual command execution are kept in E2E
 * as they test true integration behavior.
 */

import { describe, it, expect } from "vitest";
import { listCommand as artifactListCommand } from "../commands/artifact/list";
import { listCommand as volumeListCommand } from "../commands/volume/list";
import { cloneCommand as artifactCloneCommand } from "../commands/artifact/clone";
import { cloneCommand as volumeCloneCommand } from "../commands/volume/clone";

describe("Artifact List Command Configuration", () => {
  it("should have correct description", () => {
    expect(artifactListCommand.description()).toBe("List all remote artifacts");
  });

  it("should have ls alias", () => {
    expect(artifactListCommand.alias()).toBe("ls");
  });

  it("should have list as command name", () => {
    expect(artifactListCommand.name()).toBe("list");
  });

  it("should not have any required arguments", () => {
    // List command takes no arguments
    const args = artifactListCommand.registeredArguments;
    expect(args.length).toBe(0);
  });
});

describe("Volume List Command Configuration", () => {
  it("should have correct description", () => {
    expect(volumeListCommand.description()).toBe("List all remote volumes");
  });

  it("should have ls alias", () => {
    expect(volumeListCommand.alias()).toBe("ls");
  });

  it("should have list as command name", () => {
    expect(volumeListCommand.name()).toBe("list");
  });

  it("should not have any required arguments", () => {
    const args = volumeListCommand.registeredArguments;
    expect(args.length).toBe(0);
  });
});

describe("Artifact Clone Command Configuration", () => {
  it("should have correct description", () => {
    expect(artifactCloneCommand.description()).toBe(
      "Clone a remote artifact to local directory (latest version)",
    );
  });

  it("should have clone as command name", () => {
    expect(artifactCloneCommand.name()).toBe("clone");
  });

  it("should have required name argument as first argument", () => {
    const args = artifactCloneCommand.registeredArguments;
    expect(args.length).toBeGreaterThanOrEqual(1);
    const firstArg = args[0];
    expect(firstArg).toBeDefined();
    if (firstArg) {
      expect(firstArg.name()).toBe("name");
      expect(firstArg.required).toBe(true);
      expect(firstArg.description).toBe("Artifact name to clone");
    }
  });

  it("should have optional destination argument as second argument", () => {
    const args = artifactCloneCommand.registeredArguments;
    expect(args.length).toBeGreaterThanOrEqual(2);
    const secondArg = args[1];
    expect(secondArg).toBeDefined();
    if (secondArg) {
      expect(secondArg.name()).toBe("destination");
      expect(secondArg.required).toBe(false);
      expect(secondArg.description).toContain("Destination directory");
      expect(secondArg.description).toContain("default");
    }
  });

  it("should have exactly two arguments", () => {
    const args = artifactCloneCommand.registeredArguments;
    expect(args.length).toBe(2);
  });
});

describe("Volume Clone Command Configuration", () => {
  it("should have correct description", () => {
    expect(volumeCloneCommand.description()).toBe(
      "Clone a remote volume to local directory (latest version)",
    );
  });

  it("should have clone as command name", () => {
    expect(volumeCloneCommand.name()).toBe("clone");
  });

  it("should have required name argument as first argument", () => {
    const args = volumeCloneCommand.registeredArguments;
    expect(args.length).toBeGreaterThanOrEqual(1);
    const firstArg = args[0];
    expect(firstArg).toBeDefined();
    if (firstArg) {
      expect(firstArg.name()).toBe("name");
      expect(firstArg.required).toBe(true);
      expect(firstArg.description).toBe("Volume name to clone");
    }
  });

  it("should have optional destination argument as second argument", () => {
    const args = volumeCloneCommand.registeredArguments;
    expect(args.length).toBeGreaterThanOrEqual(2);
    const secondArg = args[1];
    expect(secondArg).toBeDefined();
    if (secondArg) {
      expect(secondArg.name()).toBe("destination");
      expect(secondArg.required).toBe(false);
      expect(secondArg.description).toContain("Destination directory");
      expect(secondArg.description).toContain("default");
    }
  });

  it("should have exactly two arguments", () => {
    const args = volumeCloneCommand.registeredArguments;
    expect(args.length).toBe(2);
  });
});
