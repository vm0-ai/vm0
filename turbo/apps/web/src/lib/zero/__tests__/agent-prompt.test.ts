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
    expect(prompt).not.toContain("zero remote-agent -h");
    expect(prompt).toContain("zero slack upload-file");
    expect(prompt).toContain("zero telegram message");
    expect(prompt).toContain("zero telegram bot list");
    expect(prompt).toContain("zero phone --help");
    expect(prompt).toContain("zero phone download-file");
    expect(prompt).toContain("zero phone upload-file");
    expect(prompt).toContain("unconnected, unauthenticated");
    expect(prompt).toContain("zero doctor check-connector");
    expect(prompt).toContain("explicitly choose the bot with `--bot-id`");
    expect(prompt).toContain(
      "When the user asks to generate anything (supported generation content: image, video, presentation, voice/audio, and connector-backed text, code, document, or website)",
    );
    expect(prompt).toContain("run `zero doctor generate -h`");
    expect(prompt).toContain("zero doctor generate <type>");
    expect(prompt).toContain(
      "do not claim support for other generated content",
    );
    expect(prompt).toContain(
      "wait for it to finish and use its returned artifact",
    );
    expect(prompt).toContain(
      "Do not abandon it, switch to your own generation approach, or recreate the output yourself just because generation takes a long time",
    );
    expect(prompt).not.toContain("Built-in image generation");
    expect(prompt).not.toContain("zero built-in generate image --prompt");
    expect(prompt).not.toContain("Built-in presentation generation");
    expect(prompt).not.toContain(
      "zero built-in generate presentation --prompt",
    );
    expect(prompt).toContain(
      "Do not present a local path as something the user can open",
    );
  });
});
