import { describe, it, expect } from "vitest";
import {
  getPermissionCategories,
  getConnectorFirewall,
  isFirewallConnectorType,
} from "../firewalls/index";

const CATEGORIZED_CONNECTORS = ["slack", "gmail", "vercel"] as const;

function getFirewallPermissionNames(connectorType: string): Set<string> {
  if (!isFirewallConnectorType(connectorType)) {
    return new Set();
  }
  const config = getConnectorFirewall(connectorType);
  const names = new Set<string>();
  for (const api of config.apis) {
    if (api.permissions) {
      for (const p of api.permissions) {
        names.add(p.name);
      }
    }
  }
  return names;
}

describe("firewall categories", () => {
  it("should return categories for all four categorized connectors", () => {
    for (const connector of CATEGORIZED_CONNECTORS) {
      const data = getPermissionCategories(connector);
      expect(data).not.toBeNull();
    }
  });

  it("should return null for uncategorized connectors", () => {
    expect(getPermissionCategories("notion")).toBeNull();
    expect(getPermissionCategories("linear")).toBeNull();
  });

  for (const connector of CATEGORIZED_CONNECTORS) {
    describe(connector, () => {
      it("should have a category for every permission in the firewall config", () => {
        const permNames = getFirewallPermissionNames(connector);
        const data = getPermissionCategories(connector)!;
        const categorized = new Set(Object.keys(data.categories));

        const missing = [...permNames].filter((name) => {
          return !categorized.has(name);
        });
        expect(missing).toEqual([]);
      });

      it("should not have orphan keys that are not in the firewall config", () => {
        const permNames = getFirewallPermissionNames(connector);
        const data = getPermissionCategories(connector)!;

        const orphans = Object.keys(data.categories).filter((name) => {
          return !permNames.has(name);
        });
        expect(orphans).toEqual([]);
      });

      it("should have displayOrder covering every category used", () => {
        const data = getPermissionCategories(connector)!;
        const usedCategories = new Set(Object.values(data.categories));
        const orderedCategories = new Set(data.displayOrder);

        const missing = [...usedCategories].filter((cat) => {
          return !orderedCategories.has(cat);
        });
        expect(missing).toEqual([]);
      });

      it("should have at least one permission in each displayOrder category", () => {
        const data = getPermissionCategories(connector)!;
        const categoryCounts = new Map<string, number>();
        for (const cat of Object.values(data.categories)) {
          categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
        }

        for (const cat of data.displayOrder) {
          expect(categoryCounts.get(cat) ?? 0).toBeGreaterThan(0);
        }
      });
    });
  }
});
