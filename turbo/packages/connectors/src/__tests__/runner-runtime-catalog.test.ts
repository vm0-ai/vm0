import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "../firewall-metadata/runner-runtime-catalog";
import type { Firewall } from "../firewall-types";

function firewall(name: string): Firewall {
  return projectRunnerRuntimeFirewall({
    name,
    apis: [
      {
        base: `https://${name}.example.test/v1`,
        auth: { headers: {} },
        permissions: [],
      },
    ],
  });
}

describe("runner runtime firewall catalog", () => {
  it("sorts entries and derives identity from the canonical complete map", () => {
    const catalog = createRunnerRuntimeFirewallCatalog([
      firewall("zeta"),
      firewall("alpha"),
    ]);

    expect(catalog.names).toStrictEqual(["alpha", "zeta"]);
    expect(Object.keys(catalog.firewalls)).toStrictEqual(["alpha", "zeta"]);
    const hex = createHash("sha256")
      .update(JSON.stringify(catalog.firewalls, null, 2))
      .digest("hex");
    expect(catalog.catalogDigest).toBe(`sha256:${hex}`);
    expect(catalog.catalogVersion).toBe(`sha256-${hex.slice(0, 12)}`);
  });

  it("rejects duplicate ownership", () => {
    expect(() => {
      createRunnerRuntimeFirewallCatalog([
        firewall("duplicate"),
        firewall("duplicate"),
      ]);
    }).toThrow("Duplicate runner runtime firewall name: duplicate");
  });
});
