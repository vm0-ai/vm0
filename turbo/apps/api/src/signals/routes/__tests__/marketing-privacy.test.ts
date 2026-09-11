import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { marketingPrivacyContract } from "@okouai/api-contracts/contracts/marketing-privacy";
import {
  privacyChoicesContract,
  PRIVACY_POLICY_VERSION,
  type PrivacyChoiceState,
  type PrivacyPurposes,
} from "@okouai/api-contracts/contracts/privacy-choices";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { marketingPrivacyRoutes } from "../marketing-privacy";
import { privacyChoicesRoutes } from "../privacy-choices";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const SECRET = "test-marketing-privacy-secret-at-least-32-characters";
const SENDER = Object.freeze({ authorization: `Bearer ${SECRET}` });
const GRANTED: PrivacyPurposes = Object.freeze({
  saleSharing: "granted",
  advertising: "granted",
  marketingAnalytics: "granted",
});
const T0 = Date.parse("2026-09-11T04:00:00Z");
function choices() {
  return setupApp({ context, routes: privacyChoicesRoutes })(
    privacyChoicesContract,
  );
}
function signup() {
  return setupApp({ context, routes: acquisitionAttributionRoutes })(
    acquisitionAttributionContract,
  );
}
function sender() {
  return setupApp({ context, routes: marketingPrivacyRoutes })(
    marketingPrivacyContract,
  );
}
function clock(offset: number) {
  mockNow(new Date(T0 + offset));
}
function actor() {
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, null);
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId, privateMetadata: {} }],
  });
  return userId;
}
async function choose(
  revision: string | null = null,
  purposes: PrivacyPurposes = GRANTED,
) {
  return (
    await accept(
      choices().update({
        headers: SESSION,
        body: {
          source: "explicit",
          policyVersion: PRIVACY_POLICY_VERSION,
          expectedRevision: revision,
          purposes,
        },
      }),
      [200],
    )
  ).body;
}
async function capture(state: PrivacyChoiceState) {
  if (!state.subjectId || !state.revision || !state.updatedAt) {
    throw new Error("Expected saved privacy state");
  }
  const response = await accept(
    signup().recordSignup({
      headers: SESSION,
      body: {
        attribution: { gclid: "test-click", okou_campaign_id: "24220469665" },
        privacyContext: {
          subjectId: state.subjectId,
          revision: state.revision,
          capturedAt: state.updatedAt,
        },
      },
    }),
    [200],
  );
  return response.body.privacyReceipt ?? null;
}
async function decision(
  userId: string,
  receiptId: string,
  purpose: "advertising" | "marketingAnalytics" = "advertising",
  eventOffset = 1000,
) {
  return (
    await accept(
      sender().authorize({
        headers: SENDER,
        body: {
          userId,
          receiptId,
          purpose,
          eventTime: new Date(T0 + eventOffset).toISOString(),
        },
      }),
      [200],
    )
  ).body;
}
beforeEach(() => {
  clock(0);
  mockOptionalEnv("MARKETING_PRIVACY_API_SECRET", SECRET);
});

describe("marketing privacy delivery", () => {
  it("requires sender credentials and never returns a cached authorization", async () => {
    const body = {
      userId: "user_test",
      receiptId: randomUUID(),
      purpose: "advertising" as const,
      eventTime: new Date(T0).toISOString(),
    };
    await accept(sender().authorize({ body }), [401]);
    await accept(sender().authorize({ headers: SESSION, body }), [401]);
    const response = await accept(
      sender().authorize({ headers: SENDER, body }),
      [200],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body.allowed).toBeFalsy();
  });
  it("rejects missing server configuration", async () => {
    mockOptionalEnv("MARKETING_PRIVACY_API_SECRET", undefined);
    const response = await accept(
      sender().authorize({
        headers: SENDER,
        body: {
          userId: "user_test",
          receiptId: randomUUID(),
          purpose: "advertising",
          eventTime: new Date(T0).toISOString(),
        },
      }),
      [503],
    );
    expect(response.status).toBe(503);
  });
  it("preserves an old client's signup without treating its identifiers as consent", async () => {
    actor();
    const response = await accept(
      signup().recordSignup({
        headers: SESSION,
        body: { attribution: { gclid: "legacy-click" } },
      }),
      [200],
    );
    expect(response.body.recorded).toBeTruthy();
    expect(response.body.privacyReceipt).toBeUndefined();
    expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
      expect.any(String),
      { privateMetadata: { signup_attribution: expect.any(Object) } },
    );
  });
  it("never adds a new grant receipt to a historical first touch", async () => {
    const userId = actor();
    const state = await choose();
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: {
            signup_attribution: {
              gclid: "historical-click",
              recorded_at: "2026-09-01T00:00:00Z",
            },
          },
        },
      ],
    });
    await expect(capture(state)).resolves.toBeNull();
    expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
  });
  it.each([0, -1000])(
    "only certifies Impact clicks captured after the choice (offset %s)",
    async (offset) => {
      const userId = actor();
      const state = await choose();
      if (!state.subjectId || !state.revision || !state.updatedAt) {
        throw new Error("Expected saved privacy state");
      }
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [
          {
            id: userId,
            privateMetadata: {
              signup_attribution: { gclid: "historical-click" },
            },
          },
        ],
      });
      const impactAttribution = {
        clickId: "partner-click",
        capturedAt: new Date(T0 + offset).toISOString(),
      };
      const response = await accept(
        signup().recordSignup({
          headers: SESSION,
          body: {
            attribution: {},
            impactAttribution,
            privacyContext: {
              subjectId: state.subjectId,
              revision: state.revision,
              capturedAt: state.updatedAt,
            },
          },
        }),
        [200],
      );
      expect(response.body.recorded).toBeFalsy();
      expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
        userId,
        {
          privateMetadata: {
            impact_attribution: impactAttribution,
            ...(offset === 0
              ? { impact_privacy_receipt: expect.any(String) }
              : {}),
          },
        },
      );
    },
  );
  it("authorizes a captured grant for its actual person and each allowed purpose", async () => {
    const userId = actor();
    const receipt = await capture(await choose());
    expect(receipt).not.toBeNull();
    clock(2000);
    await expect(decision(userId, receipt!)).resolves.toStrictEqual({
      allowed: true,
      reason: null,
    });
    await expect(
      decision(userId, receipt!, "marketingAnalytics"),
    ).resolves.toStrictEqual({
      allowed: true,
      reason: null,
    });
    await expect(
      decision(`user_${randomUUID()}`, receipt!),
    ).resolves.toStrictEqual({
      allowed: false,
      reason: "subject_mismatch",
    });
  });
  it("does not certify an event collected before its server capture", async () => {
    const userId = actor();
    const receipt = await capture(await choose());
    clock(2000);
    await expect(
      decision(userId, receipt!, "advertising", -1000),
    ).resolves.toStrictEqual({
      allowed: false,
      reason: "event_before_capture",
    });
  });
  it("refuses a stale or other person's capture context", async () => {
    actor();
    const state = await choose();
    clock(1000);
    await choose(state.revision, { ...GRANTED, advertising: "denied" });
    await expect(capture(state)).resolves.toBeNull();
    actor();
    await expect(capture(state)).resolves.toBeNull();
  });
  it("does not promote an event-time denied purpose after a later grant", async () => {
    const userId = actor();
    const state = await choose(null, { ...GRANTED, advertising: "denied" });
    const receipt = await capture(state);
    clock(2000);
    await choose(state.revision);
    await expect(decision(userId, receipt!)).resolves.toStrictEqual({
      allowed: false,
      reason: "purpose_denied",
    });
    await expect(
      decision(userId, receipt!, "marketingAnalytics"),
    ).resolves.toStrictEqual({
      allowed: true,
      reason: null,
    });
  });
  it.each(["explicit", "gpc"] as const)(
    "keeps pending events withdrawn after %s and subsequent opt-in",
    async (source) => {
      const userId = actor();
      const initial = await choose();
      const receipt = await capture(initial);
      clock(2000);
      const denied =
        source === "gpc"
          ? (
              await accept(
                choices().get({
                  headers: SESSION,
                  extraHeaders: { "Sec-GPC": "1" },
                }),
                [200],
              )
            ).body
          : await choose(initial.revision, {
              saleSharing: "denied",
              advertising: "denied",
              marketingAnalytics: "denied",
            });
      expect((await decision(userId, receipt!)).allowed).toBeFalsy();
      clock(3000);
      await choose(denied.revision);
      await expect(decision(userId, receipt!)).resolves.toStrictEqual({
        allowed: false,
        reason: "withdrawn",
      });
      await expect(
        decision(userId, receipt!, "marketingAnalytics"),
      ).resolves.toStrictEqual({
        allowed: false,
        reason: "withdrawn",
      });
    },
  );
  it("invalidates only the withdrawn purpose and leaves independently permitted analytics usable", async () => {
    const userId = actor();
    const state = await choose();
    const receipt = await capture(state);
    clock(2000);
    const denied = await choose(state.revision, {
      ...GRANTED,
      advertising: "denied",
    });
    clock(3000);
    await choose(denied.revision);
    await expect(decision(userId, receipt!)).resolves.toStrictEqual({
      allowed: false,
      reason: "withdrawn",
    });
    await expect(
      decision(userId, receipt!, "marketingAnalytics"),
    ).resolves.toStrictEqual({
      allowed: true,
      reason: null,
    });
  });
  it("propagates a linked anonymous withdrawal to already captured personal events", async () => {
    const userId = actor();
    const browser = (
      await accept(choices().createAnonymous({ body: {} }), [200])
    ).body;
    await accept(
      choices().associate({
        headers: SESSION,
        body: { anonymousToken: browser.token },
      }),
      [200],
    );
    const state = await choose();
    const receipt = await capture(state);
    clock(2000);
    await accept(
      choices().updateAnonymous({
        headers: { authorization: `Bearer ${browser.token}` },
        body: { source: "gpc" },
      }),
      [200],
    );
    expect((await decision(userId, receipt!)).allowed).toBeFalsy();
  });
  it("deletes delivery evidence with its person's account", async () => {
    const userId = actor();
    const receipt = await capture(await choose());
    clock(2000);
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_privacy_test");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "user.deleted",
      data: { id: userId },
    });
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: "{}" }),
      [200],
    );
    await flushWaitUntilForTest();
    await expect(decision(userId, receipt!)).resolves.toStrictEqual({
      allowed: false,
      reason: "unverified_context",
    });
  });
});
