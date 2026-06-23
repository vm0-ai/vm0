import { describe, expect, it } from "vitest";

import {
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
  loadFirewallPermissionMetadata,
} from "../firewall-metadata";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const EXPECTED_CATEGORIZED_CONNECTORS = [
  "clerk",
  "cloudflare",
  "gmail",
  "google-analytics",
  "google-calendar",
  "google-cloud",
  "google-drive",
  "google-meet",
  "google-search-console",
  "google-sheets",
  "slack",
  "stripe",
  "vercel",
  "youtube",
] as const;

const CATEGORIZED_CONNECTORS = Object.entries(
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
)
  .filter(([, summary]) => {
    return summary.hasCategories;
  })
  .map(([type]) => {
    return type;
  })
  .sort(compareStrings);

const UNCATEGORIZED_CONNECTORS = ["linear", "notion"] as const;

async function loadDetail(type: string) {
  const detail = await loadFirewallPermissionMetadata(type);
  expect(detail).not.toBeNull();
  return detail!;
}

describe("firewall categories", () => {
  it("tracks categorized connectors in generated summaries", () => {
    expect(CATEGORIZED_CONNECTORS).toStrictEqual(
      [...EXPECTED_CATEGORIZED_CONNECTORS].sort(compareStrings),
    );
  });

  it("does not emit categories for selected uncategorized connectors", async () => {
    for (const connector of UNCATEGORIZED_CONNECTORS) {
      const summary = FIREWALL_PERMISSION_METADATA_SUMMARIES[connector];
      const detail = await loadDetail(connector);

      expect(summary.hasCategories).toBe(false);
      expect(detail.categories).toBeUndefined();
    }
  });

  for (const connector of CATEGORIZED_CONNECTORS) {
    describe(connector, () => {
      it("has category metadata", async () => {
        const detail = await loadDetail(connector);

        expect(detail.categories).toBeDefined();
      });

      it("has a category for every metadata permission", async () => {
        const detail = await loadDetail(connector);
        const categories = detail.categories!;
        const categorized = new Set(Object.keys(categories.categories));

        const missing = detail.permissions
          .map((permission) => {
            return permission.name;
          })
          .filter((name) => {
            return !categorized.has(name);
          });
        expect(missing).toEqual([]);
      });

      it("does not have orphan category keys", async () => {
        const detail = await loadDetail(connector);
        const categories = detail.categories!;
        const permissionNames = new Set(
          detail.permissions.map((permission) => {
            return permission.name;
          }),
        );

        const orphans = Object.keys(categories.categories).filter((name) => {
          return !permissionNames.has(name);
        });
        expect(orphans).toEqual([]);
      });

      it("has displayOrder covering every category used", async () => {
        const detail = await loadDetail(connector);
        const categories = detail.categories!;
        const usedCategories = new Set(Object.values(categories.categories));
        const orderedCategories = new Set(categories.displayOrder);

        const missing = [...usedCategories].filter((category) => {
          return !orderedCategories.has(category);
        });
        expect(missing).toEqual([]);
      });

      it("has at least one permission in each displayOrder category", async () => {
        const detail = await loadDetail(connector);
        const categories = detail.categories!;
        const categoryCounts = new Map<string, number>();
        for (const category of Object.values(categories.categories)) {
          categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        }

        for (const category of categories.displayOrder) {
          expect(categoryCounts.get(category) ?? 0).toBeGreaterThan(0);
        }
      });
    });
  }
});
