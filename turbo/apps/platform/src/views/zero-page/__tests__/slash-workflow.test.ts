import { describe, expect, it } from "vitest";
import { matchesWorkflowNameQuery } from "../slash-workflow-match.ts";

describe("slash workflow matching", () => {
  it("matches only slug prefixes", () => {
    expect(matchesWorkflowNameQuery("pr-auto", "")).toBe(true);
    expect(matchesWorkflowNameQuery("pr-auto", "pr")).toBe(true);
    expect(matchesWorkflowNameQuery("pr-auto", "PR-AUTO")).toBe(true);
    expect(
      matchesWorkflowNameQuery("ai-slop-fallback-cleanup", "pr-auto"),
    ).toBe(false);
    expect(matchesWorkflowNameQuery("pull-request-helper", "pr-auto")).toBe(
      false,
    );
    expect(matchesWorkflowNameQuery("my-pr-auto", "pr-auto")).toBe(false);
    expect(matchesWorkflowNameQuery("pr-implement", "pr-auto")).toBe(false);
  });
});
