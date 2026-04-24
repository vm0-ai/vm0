import { describe, it, expect } from "vitest";
import { buildComposeContent } from "../build-compose-content";
import { getInstructionsFilename } from "@vm0/core/frameworks";

describe("buildComposeContent", () => {
  it("should return valid compose structure without volumes", () => {
    const result = buildComposeContent("my-agent");

    expect(result).toEqual(
      expect.objectContaining({
        version: "1",
        agents: expect.objectContaining({
          "my-agent": expect.objectContaining({
            framework: "claude-code",
            instructions: getInstructionsFilename("claude-code"),
          }),
        }),
      }),
    );

    // Skills and volumes are not part of compose — they are injected
    // as additionalVolumes at run creation time via buildSystemSkillVolumes()
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "my-agent"
    ]!;
    expect(agent.skills).toBeUndefined();
    expect(agent.volumes).toBeUndefined();
    expect(result.volumes).toBeUndefined();
  });

  it("should inject connector env var templates for GA connectors", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const environment = agent.environment as Record<string, string>;

    // GitHub is GA and maps GH_TOKEN / GITHUB_TOKEN via $secrets.*
    expect(environment.GH_TOKEN).toBe("${{ secrets.GH_TOKEN }}");
    expect(environment.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  it("should inject vars-based env var templates", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const environment = agent.environment as Record<string, string>;

    // Jira is GA and maps JIRA_DOMAIN / JIRA_EMAIL via $vars.*
    expect(environment.JIRA_DOMAIN).toBe("${{ vars.JIRA_DOMAIN }}");
    expect(environment.JIRA_EMAIL).toBe("${{ vars.JIRA_EMAIL }}");
    // Jira also has a secret-based mapping
    expect(environment.JIRA_API_TOKEN).toBe("${{ secrets.JIRA_API_TOKEN }}");
  });

  it("should inject env var templates for feature-flagged connectors with api-token", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const environment = agent.environment as Record<string, string>;

    // Mercury is feature-flagged but has api-token — its env var SHOULD be present
    expect(environment.MERCURY_TOKEN).toBe("${{ secrets.MERCURY_TOKEN }}");
  });

  it("should not inject env var templates for feature-flagged OAuth-only connectors", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const environment = agent.environment as Record<string, string>;

    // Reddit is feature-flagged and OAuth-only — its env var should NOT be present
    expect(environment.REDDIT_TOKEN).toBeUndefined();
  });

  it("should always include ZERO_AGENT_ID and ZERO_TOKEN", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const environment = agent.environment as Record<string, string>;

    expect(environment.ZERO_AGENT_ID).toBe("${{ vars.ZERO_AGENT_ID }}");
    expect(environment.ZERO_TOKEN).toBe("${{ secrets.ZERO_TOKEN }}");
  });
});
