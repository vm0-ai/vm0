import { describe, it, expect } from "vitest";
import { expandEnvironmentFromCompose } from "../expand-environment";
import type { ExpandedFirewallConfig } from "@vm0/core";

function makeCompose(
  environment: Record<string, string>,
  firewallConfigs?: ExpandedFirewallConfig[],
) {
  return {
    version: "1.0",
    agents: {
      test: {
        description: "test",
        framework: "claude-code" as const,
        environment,
        ...(firewallConfigs ? { experimental_firewalls: firewallConfigs } : {}),
      },
    },
  };
}

const githubService: ExpandedFirewallConfig = {
  name: "github",
  ref: "github",
  apis: [
    {
      base: "https://api.github.com",
      auth: {
        headers: { Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}" },
      },
    },
  ],
  placeholders: { GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000" },
};

const slackService: ExpandedFirewallConfig = {
  name: "slack",
  ref: "slack",
  apis: [
    {
      base: "https://slack.com/api",
      auth: { headers: { Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}" } },
    },
  ],
  placeholders: { SLACK_TOKEN: "xoxb-0000-0000-vm0placeholder" },
};

const airtableService: ExpandedFirewallConfig = {
  name: "airtable",
  ref: "airtable",
  apis: [
    {
      base: "https://api.airtable.com",
      auth: {
        headers: { Authorization: "Bearer ${{ secrets.AIRTABLE_TOKEN }}" },
      },
    },
  ],
};

describe("expandEnvironmentFromCompose — firewall env vars", () => {
  it("replaces secret values with firewall placeholders", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
        MY_GH: "${{ secrets.GITHUB_TOKEN }}",
      },
      [githubService],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      false,
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
    expect(environment!.MY_GH).toBe("gho_vm0placeholder0000000000000000000000");
  });

  it("does not inject placeholders when firewall is not declared", () => {
    const compose = makeCompose({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GITHUB_TOKEN: "user-provided" },
      false,
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe("user-provided");
  });

  it("handles multiple firewall configs with different placeholders", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
        SLACK_TOKEN: "${{ secrets.SLACK_TOKEN }}",
      },
      [githubService, slackService],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      false,
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
    expect(environment!.SLACK_TOKEN).toBe("xoxb-0000-0000-vm0placeholder");
  });

  it("firewall placeholder takes precedence over passed secrets", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      },
      [githubService],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GITHUB_TOKEN: "user-provided-token" },
      false,
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
  });

  it("falls back to default placeholder when no custom placeholder defined", () => {
    const compose = makeCompose(
      {
        AIRTABLE_TOKEN: "${{ secrets.AIRTABLE_TOKEN }}",
      },
      [airtableService],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      false,
    );

    expect(environment).toBeDefined();
    expect(environment!.AIRTABLE_TOKEN).toBe("VM0_PLACEHOLDER_AIRTABLE_TOKEN");
  });
});

describe("expandEnvironmentFromCompose — additionalEnvironment", () => {
  it("merges additional env vars into expansion", () => {
    const compose = makeCompose({
      MY_VAR: "hello",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { ANTHROPIC_API_KEY: "sk-xxx" },
      false,
      { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" },
    );

    expect(environment).toBeDefined();
    expect(environment!.MY_VAR).toBe("hello");
    expect(environment!.ANTHROPIC_API_KEY).toBe("sk-xxx");
  });

  it("compose entries take precedence over additional entries", () => {
    const compose = makeCompose({
      API_KEY: "compose-value",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      false,
      { API_KEY: "additional-value" },
    );

    expect(environment).toBeDefined();
    expect(environment!.API_KEY).toBe("compose-value");
  });

  it("additional secret templates go through firewall placeholder logic", () => {
    const compose = makeCompose(
      {
        MY_VAR: "hello",
      },
      [githubService],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GITHUB_TOKEN: "real-token" },
      false,
      { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
    );

    expect(environment).toBeDefined();
    expect(environment!.MY_VAR).toBe("hello");
    // Firewall placeholder should replace the real value
    expect(environment!.GH_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
  });

  it("processes additional env when compose has no environment", () => {
    const { environment } = expandEnvironmentFromCompose(
      undefined,
      undefined,
      { ANTHROPIC_API_KEY: "sk-xxx" },
      false,
      { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" },
    );

    expect(environment).toBeDefined();
    expect(environment!.ANTHROPIC_API_KEY).toBe("sk-xxx");
  });

  it("returns undefined when no compose env and no additional env", () => {
    const { environment } = expandEnvironmentFromCompose(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
    );

    expect(environment).toBeUndefined();
  });

  it("passes through literal additional entries without expansion", () => {
    const compose = makeCompose({});

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      false,
      {
        OPENAI_BASE_URL: "https://api.moonshot.cn/v1",
        ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
      },
    );

    expect(environment).toBeDefined();
    expect(environment!.OPENAI_BASE_URL).toBe("https://api.moonshot.cn/v1");
    expect(environment!.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514");
  });
});
