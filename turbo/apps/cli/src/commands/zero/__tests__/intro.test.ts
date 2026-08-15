import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroIntroCommand } from "../intro";

describe("okou intro", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints the cloud capability guide for agents", async () => {
    await zeroIntroCommand.parseAsync([], { from: "user" });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("# Okou Intro");
    expect(output).toContain("cloud computers");
    expect(output).toContain("24/7");
    expect(output).toContain("Deep Research");
    expect(output).toContain("Presentations, Reports, and Websites");
    expect(output).toContain("Lightweight Coding");
    expect(output).toContain("Workflow Automation");
    expect(output).toContain("Do not paste this intro verbatim");
  });
});
