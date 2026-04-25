import { describe, it, expect } from "vitest";
import { expandEnvironmentFromCompose } from "../expand-environment";
import type { ExpandedFirewallConfig } from "@vm0/api-contracts/contracts/firewalls";

function makeCompose(environment: Record<string, string>) {
  return {
    version: "1.0",
    agents: {
      test: {
        description: "test",
        framework: "claude-code" as const,
        environment,
      },
    },
  };
}

const githubService: ExpandedFirewallConfig = {
  name: "github",
  apis: [
    {
      base: "https://api.github.com",
      auth: {
        headers: { Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}" },
      },
    },
  ],
  placeholders: { GITHUB_TOKEN: "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" },
};

const slackService: ExpandedFirewallConfig = {
  name: "slack",
  apis: [
    {
      base: "https://slack.com/api",
      auth: { headers: { Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}" } },
    },
  ],
  placeholders: { SLACK_TOKEN: "xoxb-100100100100-1001001001001-CoffeeSaf" },
};

const airtableService: ExpandedFirewallConfig = {
  name: "airtable",
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
    const compose = makeCompose({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      MY_GH: "${{ secrets.GITHUB_TOKEN }}",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      undefined,
      [githubService],
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "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",
    );
    expect(environment!.MY_GH).toBe("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");
  });

  it("does not inject placeholders when no firewalls provided", () => {
    const compose = makeCompose({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    });

    const { environment } = expandEnvironmentFromCompose(compose, undefined, {
      GITHUB_TOKEN: "user-provided",
    });

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe("user-provided");
  });

  it("handles multiple firewall configs with different placeholders", () => {
    const compose = makeCompose({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      SLACK_TOKEN: "${{ secrets.SLACK_TOKEN }}",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      undefined,
      [githubService, slackService],
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "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",
    );
    expect(environment!.SLACK_TOKEN).toBe(
      "xoxb-100100100100-1001001001001-CoffeeSaf",
    );
  });

  it("firewall placeholder takes precedence over passed secrets", () => {
    const compose = makeCompose({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GITHUB_TOKEN: "user-provided-token" },
      undefined,
      [githubService],
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "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",
    );
  });

  it("falls back to default placeholder when no custom placeholder defined", () => {
    const compose = makeCompose({
      AIRTABLE_TOKEN: "${{ secrets.AIRTABLE_TOKEN }}",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      undefined,
      [airtableService],
    );

    expect(environment).toBeDefined();
    expect(environment!.AIRTABLE_TOKEN).toBe(
      "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe",
    );
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
      { API_KEY: "additional-value" },
    );

    expect(environment).toBeDefined();
    expect(environment!.API_KEY).toBe("compose-value");
  });

  it("additional secret templates go through firewall placeholder logic", () => {
    const compose = makeCompose({
      MY_VAR: "hello",
    });

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GITHUB_TOKEN: "real-token" },
      { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      [githubService],
    );

    expect(environment).toBeDefined();
    expect(environment!.MY_VAR).toBe("hello");
    // Firewall placeholder should replace the real value
    expect(environment!.GH_TOKEN).toBe(
      "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",
    );
  });

  it("processes additional env when compose has no environment", () => {
    const { environment } = expandEnvironmentFromCompose(
      undefined,
      undefined,
      { ANTHROPIC_API_KEY: "sk-xxx" },
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
    );

    expect(environment).toBeUndefined();
  });

  it("passes through literal additional entries without expansion", () => {
    const compose = makeCompose({});

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
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
