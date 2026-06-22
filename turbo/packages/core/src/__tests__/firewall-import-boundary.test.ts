import { describe, expect, it } from "vitest";

import * as coreRoot from "../index";
import packageJson from "../../package.json";

const runtimeFirewallRootExports = [
  "getPermissionCategories",
  "groupPermissionsByCategory",
  "isFirewallConnectorType",
  "getConnectorFirewall",
  "getDefaultFirewallPolicies",
  "resolveFirewallPolicies",
  "getAllBuiltinConnectorHosts",
  "getBuiltinConnectorDisplayName",
  "BILLABLE_CONNECTORS",
] as const;

describe("core firewall import boundary", () => {
  it("does not expose runtime firewall helpers from the package root", () => {
    for (const exportName of runtimeFirewallRootExports) {
      expect(coreRoot).not.toHaveProperty(exportName);
    }
  });

  it("does not expose the core firewall alias subpath", () => {
    expect(packageJson.exports).not.toHaveProperty("./firewalls");
  });
});
