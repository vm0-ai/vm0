import { describe, expect, it } from "vitest";

import { buildAgentPrompt } from "../agent-prompt";

describe("buildAgentPrompt", () => {
  it("tells agents to upload local files before sharing them with users", () => {
    const prompt = buildAgentPrompt({
      displayName: null,
      description: null,
      sound: null,
    });

    expect(prompt).toContain(
      "The user cannot see files on your local filesystem",
    );
    expect(prompt).toContain("zero web upload-file");
    expect(prompt).not.toContain("zero official generate voice");
    expect(prompt).not.toContain("zero web voice");
    expect(prompt).toContain("zero slack upload-file");
    expect(prompt).toContain("zero telegram message");
    expect(prompt).toContain("zero telegram bot list");
    expect(prompt).toContain("explicitly choose the bot with `--bot-id`");
    expect(prompt).toContain(
      "When the user asks to generate anything (for example, image, video, audio, or website)",
    );
    expect(prompt).toContain("run `zero doctor generate -h`");
    expect(prompt).toContain(
      "Do not present a local path as something the user can open",
    );
  });
});
