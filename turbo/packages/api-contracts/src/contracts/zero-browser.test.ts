import { describe, expect, it } from "vitest";
import { z } from "zod";

import { browserSessionChangedPayloadSchema } from "./realtime";
import { zeroBrowserContract } from "./zero-browser";

const browserId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";

function browserResponse(overrides: Record<string, unknown> = {}) {
  return {
    browser: {
      id: browserId,
      name: "browser",
      status: "active",
      viewerUrl: `https://app.vm0.ai/browsers/${browserId}`,
      liveUrl: "https://live.browser.example",
      proxyCountryCode: null,
      timeoutMinutes: 240,
      maxCredits: 1,
      grossCredits: 0,
      creditsCharged: 0,
      idleExpiresAt: "2026-07-30T01:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-07-30T01:00:00.000Z",
      updatedAt: "2026-07-30T01:00:00.000Z",
      ...overrides,
    },
    cdpUrl: "wss://cdp.browser.example",
  };
}

describe("managed browser rollout compatibility", () => {
  it("normalizes a previous API response for the thread-keyed client", () => {
    const parsed =
      zeroBrowserContract.use.responses[200].parse(browserResponse());

    expect(parsed.browser).toMatchObject({
      id: browserId,
      threadId: browserId,
    });
    expect(parsed.lifecycleEventId).toBeUndefined();
  });

  it("keeps the current API response readable by the previous client", () => {
    const previousBrowserConnectionSchema = z.object({
      browser: z.object({
        id: z.uuid(),
        name: z.string(),
        viewerUrl: z.url(),
      }),
      cdpUrl: z.url(),
    });

    expect(
      previousBrowserConnectionSchema.parse(
        browserResponse({
          threadId,
          viewerUrl: `https://app.vm0.ai/browsers/${threadId}`,
        }),
      ),
    ).toStrictEqual({
      browser: {
        id: browserId,
        name: "browser",
        viewerUrl: `https://app.vm0.ai/browsers/${threadId}`,
      },
      cdpUrl: "wss://cdp.browser.example",
    });
  });

  it("normalizes previous and current realtime payloads", () => {
    expect(
      browserSessionChangedPayloadSchema.parse({ browserId }),
    ).toStrictEqual({
      browserId,
      threadId: browserId,
    });
    expect(
      browserSessionChangedPayloadSchema.parse({ threadId }),
    ).toStrictEqual({
      browserId: threadId,
      threadId,
    });
    expect(
      browserSessionChangedPayloadSchema.parse({ browserId, threadId }),
    ).toStrictEqual({
      browserId,
      threadId,
    });
  });
});
