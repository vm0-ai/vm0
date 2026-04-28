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
    expect(prompt).toContain("zero slack upload-file");
    expect(prompt).toContain(
      "Do not present a local path as something the user can open",
    );
  });
});
