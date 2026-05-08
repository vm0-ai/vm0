import { describe, it, expect } from "vitest";

import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@vm0/api-contracts/contracts/model-providers";
import type { ExpandedFirewallConfig } from "@vm0/connectors/firewall-types";

import { mergePermissions } from "../resolve-permissions";

describe("mergePermissions — defaultPolicies on model-provider firewall", () => {
  it("routes deny names from defaultPolicies into networkPolicies.deny", () => {
    const firewall: ExpandedFirewallConfig = {
      name: "model-provider:test",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "allowed", rules: ["GET /v1/foo"] },
            { name: "denied", rules: ["ANY /*"] },
          ],
        },
      ],
      defaultPolicies: { deny: ["denied"], unknownPolicy: "deny" },
    };

    const result = mergePermissions(firewall, []);
    const policy = result?.networkPolicies["model-provider:test"];

    expect(policy?.allow).toEqual(["allowed"]);
    expect(policy?.deny).toEqual(["denied"]);
    expect(policy?.ask).toEqual([]);
    expect(policy?.unknownPolicy).toBe("deny");
  });

  it("preserves all-permissive default when defaultPolicies absent", () => {
    const firewall: ExpandedFirewallConfig = {
      name: "model-provider:test",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "x", rules: ["ANY /*"] }],
        },
      ],
    };

    const result = mergePermissions(firewall, []);
    expect(result?.networkPolicies["model-provider:test"]).toEqual({
      allow: ["x"],
      deny: [],
      ask: [],
      unknownPolicy: "allow",
    });
  });

  it("routes ask names into networkPolicies.ask and excludes them from allow", () => {
    const firewall: ExpandedFirewallConfig = {
      name: "model-provider:test",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "a", rules: ["GET /a"] },
            { name: "b", rules: ["GET /b"] },
          ],
        },
      ],
      defaultPolicies: { ask: ["b"] },
    };

    const result = mergePermissions(firewall, []);
    expect(result?.networkPolicies["model-provider:test"]?.allow).toEqual([
      "a",
    ]);
    expect(result?.networkPolicies["model-provider:test"]?.ask).toEqual(["b"]);
  });

  it("allows codex-oauth-token API permission while keeping unknown endpoints denied", () => {
    const firewall = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];

    const result = mergePermissions(firewall, []);

    expect(result?.networkPolicies["model-provider:codex-oauth-token"]).toEqual(
      {
        allow: ["codex:api"],
        deny: ["denied"],
        ask: [],
        unknownPolicy: "deny",
      },
    );
  });

  it("returns undefined when there are no firewalls at all", () => {
    expect(mergePermissions(undefined, [])).toBeUndefined();
  });
});
