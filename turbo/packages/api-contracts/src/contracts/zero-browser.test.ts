import { describe, expect, it } from "vitest";

import { browserSessionChangedPayloadSchema } from "./realtime";
import { zeroBrowserContract } from "./zero-browser";

const threadId = "22222222-2222-4222-8222-222222222222";

function browserResponse(overrides: Record<string, unknown> = {}) {
  return {
    browser: {
      threadId,
      name: "browser",
      status: "active",
      viewerUrl: `https://app.vm0.ai/browsers/${threadId}`,
      liveUrl: "https://live.browser.example",
      proxyCountryCode: null,
      timeoutMinutes: 240,
      idleExpiresAt: "2026-07-30T01:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-07-30T01:00:00.000Z",
      updatedAt: "2026-07-30T01:00:00.000Z",
      ...overrides,
    },
    cdpUrl: "wss://cdp.browser.example",
    lifecycleEventId: null,
  };
}

describe("managed browser contracts", () => {
  it("parses a thread-keyed browser response", () => {
    const parsed =
      zeroBrowserContract.use.responses[200].parse(browserResponse());

    expect(parsed.browser).toMatchObject({
      threadId,
    });
    expect(parsed.lifecycleEventId).toBeNull();
  });

  it("parses a thread-keyed realtime payload", () => {
    expect(
      browserSessionChangedPayloadSchema.parse({ threadId }),
    ).toStrictEqual({
      threadId,
    });
  });

  it("rejects legacy browser IDs", () => {
    expect(() => {
      browserSessionChangedPayloadSchema.parse({
        browserId: "11111111-1111-4111-8111-111111111111",
      });
    }).toThrow();
    expect(() => {
      zeroBrowserContract.use.responses[200].parse(
        browserResponse({
          id: "11111111-1111-4111-8111-111111111111",
        }),
      );
    }).toThrow();
  });
});
