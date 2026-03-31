import { describe, it, expect } from "vitest";
import { buildComposeContent } from "../build-compose-content";
import { SEED_SKILLS } from "../seed-skills";
import {
  CONNECTOR_TYPES,
  resolveSkillRef,
  getInstructionsFilename,
} from "@vm0/core";

/** Connector types that are NOT behind a feature flag (generally available). */
const gaConnectorTypes = Object.entries(CONNECTOR_TYPES)
  .filter(([, config]) => {
    return !config.featureFlag;
  })
  .map(([type]) => {
    return type;
  });

/** Connector types that ARE behind a feature flag. */
const flaggedConnectorTypes = Object.entries(CONNECTOR_TYPES)
  .filter(([, config]) => {
    return !!config.featureFlag;
  })
  .map(([type]) => {
    return type;
  });

describe("buildComposeContent", () => {
  it("should return valid compose structure", () => {
    const result = buildComposeContent("my-agent");

    expect(result).toEqual(
      expect.objectContaining({
        version: "1",
        agents: expect.objectContaining({
          "my-agent": expect.objectContaining({
            framework: "claude-code",
            instructions: getInstructionsFilename("claude-code"),
            volumes: [],
          }),
        }),
      }),
    );
  });

  it("should include all seed skills", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const skills = agent.skills as string[];

    for (const seedSkill of SEED_SKILLS) {
      const url = resolveSkillRef(seedSkill);
      expect(skills).toContain(url);
    }
  });

  it("should include GA connector types as skills", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const skills = agent.skills as string[];

    for (const connectorType of gaConnectorTypes) {
      const url = resolveSkillRef(connectorType);
      expect(skills).toContain(url);
    }
  });

  it("should exclude feature-flagged connector types from skills", () => {
    // Sanity: there are flagged connectors to exclude
    expect(flaggedConnectorTypes.length).toBeGreaterThan(0);

    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const skills = agent.skills as string[];

    for (const connectorType of flaggedConnectorTypes) {
      const url = resolveSkillRef(connectorType);
      expect(skills).not.toContain(url);
    }
  });

  it("should not produce duplicate skills", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const skills = agent.skills as string[];
    const unique = new Set(skills);

    expect(skills).toHaveLength(unique.size);
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

  it("should not inject env var templates for feature-flagged connectors", () => {
    const result = buildComposeContent("agent");
    const agent = (result.agents as Record<string, Record<string, unknown>>)[
      "agent"
    ]!;
    const environment = agent.environment as Record<string, string>;

    // Ahrefs is feature-flagged — its env var should NOT be present
    expect(environment.AHREFS_TOKEN).toBeUndefined();
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
