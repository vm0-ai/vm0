import { describe, expect, it } from "vitest";
import { matchesWorkflowNameQuery } from "../slash-workflow-match.ts";

describe("slash workflow matching", () => {
  it("matches slug substrings", () => {
    expect(matchesWorkflowNameQuery("pr-auto", "")).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "pr")).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "PR-AUTO")).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("ai-slop-fallback-cleanup", "fallback"),
    ).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("pull-request-helper", "REQUEST"),
    ).toBeTruthy();
    expect(matchesWorkflowNameQuery("my-pr-auto", "pr-auto")).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-implement", "pr-auto")).toBeFalsy();
  });
});
