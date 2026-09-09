import { describe, expect, it } from "vitest";

import type { ConnectorCategorySection } from "../connector-categories.ts";
import { buildConnectorShelves } from "../connector-shelves.ts";

interface TestConnector {
  readonly slug: string;
  readonly label: string;
  readonly popularityRank?: number;
}

function section(
  category: string,
  connectors: readonly TestConnector[],
): ConnectorCategorySection<TestConnector> {
  return {
    category,
    label: `${category} label`,
    menuLabel: category,
    groupId: null,
    connectors: [...connectors],
  };
}

/** `count` connectors, ranked from `from`, named so the alphabet is visible. */
function ranked(prefix: string, count: number, from: number): TestConnector[] {
  return Array.from({ length: count }, (_, index) => {
    return {
      slug: `${prefix}-${index}`,
      label: `${prefix.toUpperCase()} ${index}`,
      popularityRank: from + index,
    };
  });
}

function unranked(prefix: string, count: number): TestConnector[] {
  return Array.from({ length: count }, (_, index) => {
    return { slug: `${prefix}-x${index}`, label: `1${prefix}${index}` };
  });
}

function build(
  sections: readonly ConnectorCategorySection<TestConnector>[],
  categoryCounts?: Record<string, number>,
) {
  return buildConnectorShelves({
    sections,
    categoryCounts,
    headLabel: "Popular",
  });
}

describe("buildConnectorShelves", () => {
  it("shows a connector on one shelf only", () => {
    const layout = build([
      section("mail", [...ranked("mail", 6, 0), ...unranked("mail", 20)]),
      section("crm", [...ranked("crm", 6, 10), ...unranked("crm", 20)]),
    ]);

    const seen = layout.shelves.flatMap((shelf) => {
      return shelf.connectors.map((connector) => {
        return connector.slug;
      });
    });
    expect(new Set(seen).size).toBe(seen.length);
    // The head shelf takes the best of each category, so those two do not open
    // their own category again.
    expect(
      layout.shelves[0]?.connectors.map((connector) => {
        return connector.slug;
      }),
    ).toStrictEqual(["mail-0", "crm-0"]);
    expect(layout.shelves[1]?.connectors[0]?.slug).toBe("mail-1");
  });

  it("keeps the alphabet out of a shelf and inside its tail", () => {
    const layout = build(
      [section("mail", [...ranked("mail", 5, 0), ...unranked("mail", 40)])],
      { mail: 300 },
    );

    const mail = layout.shelves.find((shelf) => {
      return shelf.category === "mail";
    });
    expect(
      mail?.connectors.every((connector) => {
        return connector.popularityRank !== undefined;
      }),
    ).toBeTruthy();
    expect(mail?.tail.length).toBe(3);
    expect(mail?.remaining).toBe(300 - (mail?.connectors.length ?? 0));
  });

  it("offers a thinly ranked category as a counted chip instead of a shelf", () => {
    const layout = build(
      [
        section("mail", ranked("mail", 6, 0)),
        section("voice", [...ranked("voice", 1, 40), ...unranked("voice", 49)]),
      ],
      { mail: 327, voice: 50 },
    );

    expect(
      layout.shelves.map((shelf) => {
        return shelf.category;
      }),
    ).toStrictEqual([null, "mail"]);
    expect(layout.chips).toStrictEqual([
      { category: "voice", label: "voice", total: 50 },
    ]);
  });

  it("still fills shelves when the API sends no ranking at all", () => {
    // An older API has no popularityRank, and the browse view must not go
    // blank on it: every category keeps a shelf and the head shelf, which only
    // means something against a ranking, is dropped.
    const layout = build([
      section("mail", unranked("mail", 30)),
      section("crm", unranked("crm", 12)),
    ]);

    expect(
      layout.shelves.map((shelf) => {
        return shelf.category;
      }),
    ).toStrictEqual(["mail", "crm"]);
    expect(layout.shelves[0]?.connectors).toHaveLength(6);
    expect(layout.chips).toStrictEqual([]);
  });

  it("stands a shelf down when its whole preview went to the head", () => {
    const layout = build([section("mail", ranked("mail", 4, 0))], { mail: 4 });

    expect(layout.shelves[0]?.category).toBeNull();
    expect(layout.shelves).toHaveLength(2);
    expect(layout.shelves[1]?.connectors).toHaveLength(3);
    expect(layout.shelves[1]?.tail).toStrictEqual([]);
  });
});
