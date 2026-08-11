import { describe, expect, it } from "vitest";

import {
  databaseFields,
  extractAttribution,
  likelyCreatorUserId,
  reconcileCandidates,
  type AttributionCandidate,
} from "./backfill";

function candidate(
  source: AttributionCandidate["source"],
  attribution: AttributionCandidate["attribution"],
  recordedAt: string,
): AttributionCandidate {
  return { source, attribution, recordedAt: new Date(recordedAt) };
}

describe("extractAttribution", () => {
  it("keeps only validated attribution keys and trims their values", () => {
    expect(
      extractAttribution({
        gclid: " click-1 ",
        utm_campaign: "launch",
        recorded_at: "2026-07-20T00:00:00.000Z",
        orgId: "org_ignored",
      }),
    ).toEqual({ gclid: "click-1", utm_campaign: "launch" });
  });

  it("rejects unknown-only fallback records", () => {
    expect(extractAttribution({ source_type: "unknown" })).toBeUndefined();
  });

  it("keeps valid non-paid first-touch attribution", () => {
    expect(extractAttribution({ source_type: "direct" })).toEqual({
      source_type: "direct",
    });
  });

  it("rejects an invalid stored payload instead of partially accepting it", () => {
    expect(
      extractAttribution({
        gclid: "click-1",
        source_type: "not-a-source-type",
      }),
    ).toBeUndefined();
  });
});

describe("databaseFields", () => {
  it("reports only fields represented by org_metadata", () => {
    expect(
      databaseFields({
        gclid: "click-1",
        utm_term: "agent automation",
        vm0_experiment: "landing-page",
      }),
    ).toEqual(["utm_term", "gclid"]);
  });
});

describe("likelyCreatorUserId", () => {
  const createdAt = Date.parse("2026-07-20T00:00:00.000Z");

  it("selects the earliest current membership created with the org", () => {
    expect(
      likelyCreatorUserId(createdAt, [
        { userId: "user_invited", createdAt: createdAt + 60_000 },
        { userId: "user_creator", createdAt },
      ]),
    ).toEqual({ userId: "user_creator" });
  });

  it("does not guess when the original creator is no longer a member", () => {
    expect(
      likelyCreatorUserId(createdAt, [
        { userId: "user_later", createdAt: createdAt + 60 * 60_000 },
      ]),
    ).toEqual({ reason: "creator_not_current_member" });
  });

  it("does not guess between memberships with the same creation time", () => {
    expect(
      likelyCreatorUserId(createdAt, [
        { userId: "user_a", createdAt },
        { userId: "user_b", createdAt },
      ]),
    ).toEqual({ reason: "creator_membership_ambiguous" });
  });
});

describe("reconcileCandidates", () => {
  it("merges complementary Clerk and Stripe copies", () => {
    const result = reconcileCandidates([
      candidate(
        "clerk_creator",
        { gclid: "click-1", utm_campaign: "launch" },
        "2026-07-20T00:00:00.000Z",
      ),
      candidate(
        "stripe_customer",
        { gclid: "click-1", vm0_campaign_id: "campaign-1" },
        "2026-07-21T00:00:00.000Z",
      ),
    ]);

    expect(result).toEqual({
      attribution: {
        gclid: "click-1",
        utm_campaign: "launch",
        vm0_campaign_id: "campaign-1",
      },
      recordedAt: new Date("2026-07-20T00:00:00.000Z"),
      sources: ["clerk_creator", "stripe_customer"],
      conflictFields: [],
    });
  });

  it("refuses to choose between conflicting source values", () => {
    expect(
      reconcileCandidates([
        candidate(
          "clerk_creator",
          { gclid: "click-1" },
          "2026-07-20T00:00:00.000Z",
        ),
        candidate(
          "stripe_subscription",
          { gclid: "click-2" },
          "2026-07-21T00:00:00.000Z",
        ),
      ]),
    ).toEqual({
      sources: ["clerk_creator", "stripe_subscription"],
      conflictFields: ["gclid"],
    });
  });
});
