import { describe, expect, it } from "vitest";

import {
  CONNECTOR_DISCOVERY_PER_CATEGORY,
  CONNECTOR_POPULARITY_RANKING,
  INTERNAL_CONNECTOR_SLUGS,
  compareConnectorPopularity,
  connectorPopularityRank,
  isInternalConnector,
} from "../connector-popularity";

describe("connector popularity ranking", () => {
  it("ranks each slug once", () => {
    const seen = new Set(CONNECTOR_POPULARITY_RANKING);
    expect(seen.size).toBe(CONNECTOR_POPULARITY_RANKING.length);
  });

  it("never ranks a connector Okou operates for itself", () => {
    const internal = CONNECTOR_POPULARITY_RANKING.filter((slug) => {
      return INTERNAL_CONNECTOR_SLUGS.has(slug);
    });
    expect(internal).toStrictEqual([]);
  });

  it("leads with the connectors a business user arrives looking for", () => {
    // The ranking this replaced put Stripe at 97 and omitted Salesforce, so
    // the head of the list is the part worth pinning down.
    for (const slug of ["gmail", "google-drive", "slack", "stripe"]) {
      expect(connectorPopularityRank(slug)).toBeLessThan(30);
    }
    expect(connectorPopularityRank("salesforce")).toBeLessThan(
      CONNECTOR_POPULARITY_RANKING.length,
    );
  });

  it("sorts an unranked connector after every ranked one", () => {
    expect(connectorPopularityRank("some-unranked-connector")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    const ordered = [
      { slug: "zzz-unranked", label: "AAA Unranked" },
      { slug: "slack", label: "Slack" },
    ].sort(compareConnectorPopularity);
    expect(ordered[0]?.slug).toBe("slack");
  });

  it("breaks ties between unranked connectors on the label", () => {
    const ordered = [
      { slug: "b-tool", label: "Beta" },
      { slug: "a-tool", label: "Alpha" },
    ].sort(compareConnectorPopularity);
    expect(
      ordered.map((entry) => {
        return entry.label;
      }),
    ).toStrictEqual(["Alpha", "Beta"]);
  });

  it("reports the connectors we operate ourselves", () => {
    expect(isInternalConnector("maskdb")).toBeTruthy();
    expect(isInternalConnector("slack")).toBeFalsy();
  });

  it("gives every category room on the first screen", () => {
    // Twelve categories at this slice stay well inside a single response,
    // which is what lets discovery stop returning one global top-100.
    expect(CONNECTOR_DISCOVERY_PER_CATEGORY).toBeGreaterThan(0);
    expect(CONNECTOR_DISCOVERY_PER_CATEGORY * 12).toBeLessThanOrEqual(200);
  });
});
