import { describe, expect, it } from "vitest";
import { matchesWorkflowNameQuery } from "../slash-workflow-match.ts";

describe("slash workflow matching", () => {
  it("matches only slug prefixes when substring search is disabled", () => {
    expect(matchesWorkflowNameQuery("pr-auto", "", false)).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "pr", false)).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "PR-AUTO", false)).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("ai-slop-fallback-cleanup", "fallback", false),
    ).toBeFalsy();
    expect(
      matchesWorkflowNameQuery("pull-request-helper", "REQUEST", false),
    ).toBeFalsy();
    expect(
      matchesWorkflowNameQuery("my-pr-auto", "pr-auto", false),
    ).toBeFalsy();
    expect(
      matchesWorkflowNameQuery("pr-implement", "pr-auto", false),
    ).toBeFalsy();
  });

  it("matches slug substrings when substring search is enabled", () => {
    expect(matchesWorkflowNameQuery("pr-auto", "", true)).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "pr", true)).toBeTruthy();
    expect(matchesWorkflowNameQuery("pr-auto", "PR-AUTO", true)).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("ai-slop-fallback-cleanup", "fallback", true),
    ).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("pull-request-helper", "REQUEST", true),
    ).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("my-pr-auto", "pr-auto", true),
    ).toBeTruthy();
    expect(
      matchesWorkflowNameQuery("pr-implement", "pr-auto", true),
    ).toBeFalsy();
  });
});
