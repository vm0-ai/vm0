import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroWorkflowCommand } from "../index";

describe("legacy automation command hard cut", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides the legacy command from workflow help", () => {
    const help = zeroWorkflowCommand.helpInformation();

    expect(help).toContain("automation");
    expect(help).not.toContain("trigger");
  });

  it("directs legacy invocations to workflow automation and exits 1", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(
      zeroWorkflowCommand.parseAsync([
        "node",
        "cli",
        "trigger",
        "list",
        "workflow-id",
        "--agent",
        "agent-id",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(error).toHaveBeenCalledWith("renamed: use zero workflow automation");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("hard-cuts the legacy help path too", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(
      zeroWorkflowCommand.parseAsync(["node", "cli", "trigger", "--help"]),
    ).rejects.toThrow("process.exit called");

    expect(error).toHaveBeenCalledWith("renamed: use zero workflow automation");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
