import { describe, it, expect } from "vitest";
import { CONNECTOR_TYPES } from "../connectors";
import type { ConnectorType } from "../connectors";
import { getFirewallConfig } from "../firewall";

describe("getFirewallConfig", () => {
  it("returns proxy config for known connector types", () => {
    const config = getFirewallConfig("github");
    expect(config).toBeDefined();
    expect(config!.apis[0]!.base).toBe("https://api.github.com");
    expect(config!.apis[0]!.auth.headers.Authorization).toBe(
      "Bearer ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(config!.placeholders).toEqual({
      GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000",
    });
  });

  it("returns config with multiple apis for slack", () => {
    const config = getFirewallConfig("slack");
    expect(config).toBeDefined();
    expect(config!.apis.map((s) => s.base)).toEqual([
      "https://slack.com/api",
      "https://files.slack.com",
    ]);
    expect(config!.placeholders).toEqual({
      SLACK_TOKEN: "xoxb-0000-0000-vm0placeholder",
    });
  });

  it("returns config with custom headers for notion", () => {
    const config = getFirewallConfig("notion");
    expect(config).toBeDefined();
    expect(config!.apis[0]!.auth.headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("returns undefined for computer connector (no proxy support)", () => {
    const config = getFirewallConfig("computer");
    expect(config).toBeUndefined();
  });

  it("all proxy configs have valid apis and auth headers", () => {
    const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

    for (const type of allTypes) {
      const config = getFirewallConfig(type);
      if (!config) continue;

      expect(
        config.apis.length,
        `${type} should have at least one api`,
      ).toBeGreaterThan(0);
      for (const api of config.apis) {
        expect(api.base, `${type} api base should be https URL`).toMatch(
          /^https:\/\//,
        );
        expect(
          Object.keys(api.auth.headers).length,
          `${type} api should have at least one auth header`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
