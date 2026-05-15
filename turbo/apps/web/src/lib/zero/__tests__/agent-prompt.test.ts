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
    expect(prompt).toContain(
      "After selecting a Zero generation command, wait for it to complete",
    );
    expect(prompt).toContain("zero built-in generate image --prompt");
    expect(prompt).toContain(
      "OpenAI `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`",
    );
    expect(prompt).toContain(
      "fal.ai `flux-pro-1.1`, `flux-pro-1.1-ultra`, `qwen-image`, `seedream4`",
    );
    expect(prompt).toContain("Prefer OpenAI image models");
    expect(prompt).toContain("`--model`");
    expect(prompt).toContain("flexible `--size`");
    expect(prompt).toContain("`--compression`");
    expect(prompt).toContain("`--moderation`");
    expect(prompt).toContain("`--seed`");
    expect(prompt).toContain("`--safety-tolerance`");
    expect(prompt).toContain("do not support transparent backgrounds");
    expect(prompt).toContain("reference images, masks");
    expect(prompt).toContain("Pass `--json`");
    expect(prompt).toContain("zero built-in generate presentation --prompt");
    expect(prompt).toContain("`--image-model`");
    expect(prompt).toContain(
      "Do not present a local path as something the user can open",
    );
  });
});
