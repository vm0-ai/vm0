import { describe, expect, it } from "vitest";
import { matchesWorkflowNameQuery } from "../slash-workflow-match.ts";

describe("slash workflow matching", () => {
  it("matches only slug prefixes", () => {
    expect(matchesWorkflowNameQuery("pr-auto", "")).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "pr")).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "PR-AUTO")).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("ai-slop-fallback-cleanup", "pr-auto"),
    ).toBeFalsy();
    expect(
      matchesWorkflowNameQuery("pull-request-helper", "pr-auto"),
    ).toBeFalsy();
    expect(matchesWorkflowNameQuery("my-pr-auto", "pr-auto")).toBeFalsy();
    expect(matchesWorkflowNameQuery("pr-implement", "pr-auto")).toBeFalsy();
  });
});
