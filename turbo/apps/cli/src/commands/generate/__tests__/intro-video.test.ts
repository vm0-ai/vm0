import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { HYPERFRAMES_VIDEO_TEMPLATES_ENABLED_ENV } from "@okouai/core/hyperframes-source";
import { HYPERFRAMES_TEMPLATE_ITEMS } from "@okouai/core/hyperframes-template-items";

import { generateCommand } from "../index";

describe("okou generate intro-video command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv(HYPERFRAMES_VIDEO_TEMPLATES_ENABLED_ENV, "1");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("prints a locked Interview packet from the official HyperFrames source", async () => {
    const template = HYPERFRAMES_TEMPLATE_ITEMS[0]!;

    await generateCommand.parseAsync([
      "node",
      "cli",
      "intro-video",
      "--template",
      template.id,
      "--prompt",
      "Turn the founder interview into a concise explainer",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      `# Okou generate intro-video --template ${template.id}`,
    );
    expect(stdout).toContain("Official workflow: faceless-explainer");
    expect(stdout).toContain("Story pattern: quote-led interview");
    expect(stdout).toContain("kinetic-type-beats");
    expect(stdout).toContain("fixed-anchor-cycle");
    expect(stdout).toContain("spring-pop-entrance");
    expect(stdout).toContain("heygen-com/hyperframes");
    expect(stdout).toContain("6eaa2cb64b280c51cadb3843ce190f6f0b7493cc");
    expect(stdout).toContain("hyperframes@0.8.14");
    expect(stdout).toContain("HYPERFRAMES_SKIP_SKILLS=1");
    expect(stdout).toContain(
      "Do not run `hyperframes skills update`, `hyperframes@latest`, or `hyperframes upgrade`",
    );
    expect(stdout).toContain(
      "Give each beat one dominant visual focus; crop into the relevant detail",
    );
    expect(stdout).toContain(
      "Do not use opacity fading as an element's primary entrance",
    );
    expect(stdout).toContain("./generated/videos/interview/renders/video.mp4");
    expect(stdout).not.toContain("nexu-io/open-design");
    expect(stdout).not.toContain("okou generate video --provider built-in");
  });

  it("rejects the command when the run switch is off", async () => {
    vi.stubEnv(HYPERFRAMES_VIDEO_TEMPLATES_ENABLED_ENV, "0");

    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "intro-video",
        "--template",
        "hyperframes-template:interview",
        "--prompt",
        "Make an interview video",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "HyperFrames intro-video templates are not enabled for this run.",
      ),
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });
});
