import { describe, expect, it } from "vitest";

import { normalizeTeamsActivity } from "./teams-bot-activity";

function teamsMessageActivity(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id: "activity-1",
    timestamp: "2026-06-30T09:10:00.000Z",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversation: { id: "19:thread@thread.tacv2" },
    channelData: { tenant: { id: "tenant-1" } },
    ...overrides,
  };
}

describe("normalizeTeamsActivity", () => {
  it("rejects an activity without a stable identifier", () => {
    const result = normalizeTeamsActivity(
      teamsMessageActivity({ id: undefined, timestamp: undefined }),
    );

    expect(result).toStrictEqual({
      ok: false,
      error: "Missing Teams activity id or timestamp",
    });
  });

  it("rejects a message without an activity id", () => {
    const result = normalizeTeamsActivity(
      teamsMessageActivity({ id: undefined }),
    );

    expect(result).toStrictEqual({
      ok: false,
      error: "Missing Teams message activity id",
    });
  });
});
