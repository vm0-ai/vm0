import { describe, it, expect } from "vitest";
import { expandEnvironmentFromCompose } from "../expand-environment";

function makeCompose(
  environment: Record<string, string>,
  connectors?: string[],
) {
  return {
    version: "1.0",
    agents: {
      test: {
        description: "test",
        framework: "claude-code" as const,
        working_dir: "/home/user",
        environment,
        ...(connectors ? { experimental_connectors: connectors } : {}),
      },
    },
  };
}

describe("expandEnvironmentFromCompose — connector env vars", () => {
  it("replaces secret values with connector placeholders when connector is connected", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GH_TOKEN }}",
        GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      },
      ["github"],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      undefined,
      "user-1",
      "run-1",
      false,
      ["github"],
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
    expect(environment!.GITHUB_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
  });

  it("does not inject placeholders when connector is not connected", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GH_TOKEN }}",
      },
      ["github"],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GH_TOKEN: "user-provided" },
      undefined,
      "user-1",
      "run-1",
      false,
      [], // no connected types
    );

    expect(environment).toBeDefined();
    // Connector not connected → falls back to passed secret
    expect(environment!.GH_TOKEN).toBe("user-provided");
  });

  it("does not inject placeholders when connector is not declared", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GH_TOKEN }}",
      },
      // no experimental_connectors
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GH_TOKEN: "user-provided" },
      undefined,
      "user-1",
      "run-1",
      false,
      ["github"],
    );

    expect(environment).toBeDefined();
    // Connector not declared → falls back to passed secret
    expect(environment!.GH_TOKEN).toBe("user-provided");
  });

  it("handles multiple connectors with different placeholders", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GH_TOKEN }}",
        SLACK_TOKEN: "${{ secrets.SLACK_TOKEN }}",
      },
      ["github", "slack"],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      undefined,
      "user-1",
      "run-1",
      false,
      ["github", "slack"],
    );

    expect(environment).toBeDefined();
    expect(environment!.GH_TOKEN).toBe(
      "gho_vm0placeholder0000000000000000000000",
    );
    expect(environment!.SLACK_TOKEN).toBe("xoxb-0000-0000-vm0placeholder");
  });

  it("connector placeholder takes precedence over passed secrets", () => {
    const compose = makeCompose(
      {
        GH_TOKEN: "${{ secrets.GH_TOKEN }}",
      },
      ["github"],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      { GH_TOKEN: "user-provided-token" },
      undefined,
      "user-1",
      "run-1",
      false,
      ["github"],
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
      ["airtable"],
    );

    const { environment } = expandEnvironmentFromCompose(
      compose,
      undefined,
      undefined,
      undefined,
      "user-1",
      "run-1",
      false,
      ["airtable"],
    );

    expect(environment).toBeDefined();
    // Airtable has no custom placeholder → uses default VM0_PLACEHOLDER_ prefix
    expect(environment!.AIRTABLE_TOKEN).toBe("VM0_PLACEHOLDER_AIRTABLE_TOKEN");
  });
});
