import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  PRIVACY_POLICY_VERSION,
  privacyChoicesContract,
  type PrivacyChoiceUpdate,
  type PrivacyPurposes,
} from "@okouai/api-contracts/contracts/privacy-choices";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { privacyChoicesRoutes } from "../privacy-choices";
import { createRouteMocks } from "./helpers/route-test";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const GRANTED: PrivacyPurposes = Object.freeze({
  saleSharing: "granted",
  advertising: "granted",
  marketingAnalytics: "granted",
});
const DENIED: PrivacyPurposes = Object.freeze({
  saleSharing: "denied",
  advertising: "denied",
  marketingAnalytics: "denied",
});
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: privacyChoicesRoutes })(
    privacyChoicesContract,
  );
}

function explicit(
  expectedRevision: string | null,
  purposes: PrivacyPurposes = GRANTED,
): PrivacyChoiceUpdate {
  return {
    source: "explicit",
    policyVersion: PRIVACY_POLICY_VERSION,
    expectedRevision,
    purposes,
  };
}

function tokenHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function browser(choice?: PrivacyChoiceUpdate) {
  return (await accept(client().createAnonymous({ body: { choice } }), [200]))
    .body;
}

function signIn(userId = `user_${randomUUID()}`, orgId: string | null = null) {
  mocks.clerk.session(userId, orgId);
  return userId;
}

async function associate(token: string) {
  return await accept(
    client().associate({
      headers: sessionHeaders,
      body: { anonymousToken: token },
    }),
    [200],
  );
}

describe("privacy choices", () => {
  it("requires the person's session to restore consent through a linked browser", async () => {
    const created = await browser({ source: "gpc" });
    signIn();
    const linked = await associate(created.token);
    const grant = explicit(linked.body.revision);
    expect(
      (
        await client().updateAnonymous({
          headers: tokenHeaders(created.token),
          body: grant,
        })
      ).status,
    ).toBe(403);
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body,
    ).toStrictEqual(linked.body);
    const restored = await accept(
      client().update({ headers: sessionHeaders, body: grant }),
      [200],
    );
    expect(restored.body.advertisingAllowed).toBeTruthy();
    expect(
      (
        await accept(
          client().getAnonymous({ headers: tokenHeaders(created.token) }),
          [200],
        )
      ).body,
    ).toStrictEqual(restored.body);
  });

  it("accepts the same necessary receipt from marketing, auth, and app origins", async () => {
    const created = await browser({ source: "gpc" });
    for (const origin of [
      "https://okou.ai",
      "https://auth.okou.ai",
      "https://app.okou.ai",
    ]) {
      const read = await accept(
        client().getAnonymous({
          headers: tokenHeaders(created.token),
          extraHeaders: { origin },
        }),
        [200],
      );
      expect(read.headers.get("access-control-allow-origin")).toBe(origin);
      expect(read.body).toStrictEqual(created.state);
    }
  });

  it("invalidates a deleted person's browser receipts while preserving unrelated anonymous choices", async () => {
    const first = await browser({ source: "gpc" });
    const second = await browser();
    const unrelated = await browser({ source: "gpc" });
    const userId = signIn();
    await associate(first.token);
    await associate(second.token);
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
    expect(
      (await client().getAnonymous({ headers: tokenHeaders(first.token) }))
        .status,
    ).toBe(404);
    expect(
      (await client().getAnonymous({ headers: tokenHeaders(second.token) }))
        .status,
    ).toBe(404);
    expect(
      (
        await accept(
          client().getAnonymous({ headers: tokenHeaders(unrelated.token) }),
          [200],
        )
      ).body,
    ).toStrictEqual(unrelated.state);
  });

  it("keeps a new anonymous visitor unknown and persists its necessary preference without login", async () => {
    const created = await browser();
    expect(created.state).toMatchObject({
      source: null,
      updatedAt: null,
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    });
    const saved = await accept(
      client().updateAnonymous({
        headers: tokenHeaders(created.token),
        body: explicit(created.state.revision, DENIED),
      }),
      [200],
    );
    expect(saved.body).toMatchObject({
      purposes: DENIED,
      source: "explicit",
      policyVersion: PRIVACY_POLICY_VERSION,
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    });
    expect(saved.body.updatedAt).not.toBeNull();
    const returned = await accept(
      client().getAnonymous({ headers: tokenHeaders(created.token) }),
      [200],
    );
    expect(returned.body).toStrictEqual(saved.body);
    expect(returned.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(returned.body)).not.toContain(created.token);
  });

  it("does not infer account consent from an authenticated session", async () => {
    signIn();
    const read = await accept(client().get({ headers: sessionHeaders }), [200]);
    expect(read.body).toMatchObject({
      subjectId: null,
      revision: null,
      source: null,
      purposes: {
        saleSharing: "unknown",
        advertising: "unknown",
        marketingAnalytics: "unknown",
      },
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    });
  });

  it("requires a privacy capability for anonymous reads and writes", async () => {
    expect((await client().getAnonymous()).status).toBe(401);
    expect(
      (await client().updateAnonymous({ body: { source: "gpc" } })).status,
    ).toBe(401);
    const fake = `pc_${"0".repeat(64)}`;
    expect(
      (await client().getAnonymous({ headers: tokenHeaders(fake) })).status,
    ).toBe(404);
    expect(
      (await client().getAnonymous({ headers: sessionHeaders })).status,
    ).toBe(401);
  });

  it("requires a signed-in session for account access and association", async () => {
    const created = await browser();
    expect((await client().get()).status).toBe(401);
    expect((await client().update({ body: { source: "gpc" } })).status).toBe(
      401,
    );
    expect(
      (await client().associate({ body: { anonymousToken: created.token } }))
        .status,
    ).toBe(401);
  });

  it("keeps purposes independent and disables both on sale/sharing opt-out", async () => {
    const created = await browser(
      explicit(null, { ...GRANTED, advertising: "denied" }),
    );
    expect(created.state).toMatchObject({
      advertisingAllowed: false,
      marketingAnalyticsAllowed: true,
    });
    const withdrawn = await accept(
      client().updateAnonymous({
        headers: tokenHeaders(created.token),
        body: explicit(created.state.revision, {
          ...GRANTED,
          saleSharing: "denied",
        }),
      }),
      [200],
    );
    expect(withdrawn.body).toMatchObject({
      purposes: DENIED,
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    });
  });

  it("persists GPC seen during a read and does not restore a grant when GPC disappears", async () => {
    const created = await browser(explicit(null));
    const withdrawn = await accept(
      client().getAnonymous({
        headers: { ...tokenHeaders(created.token), "sec-gpc": "1" },
      }),
      [200],
    );
    expect(withdrawn.body).toMatchObject({ source: "gpc", purposes: DENIED });
    const returned = await accept(
      client().getAnonymous({ headers: tokenHeaders(created.token) }),
      [200],
    );
    expect(returned.body).toStrictEqual(withdrawn.body);
    expect(
      (
        await client().updateAnonymous({
          headers: tokenHeaders(created.token),
          body: explicit(created.state.revision),
        })
      ).status,
    ).toBe(409);
    const repeated = await accept(
      client().getAnonymous({
        headers: { ...tokenHeaders(created.token), "sec-gpc": "1" },
      }),
      [200],
    );
    expect(repeated.body.revision).toBe(withdrawn.body.revision);
  });

  it("honors GPC during creation and gives it precedence over a fresh explicit grant", async () => {
    const created = await accept(
      client().createAnonymous({
        headers: { "sec-gpc": "1" },
        body: { choice: explicit(null) },
      }),
      [200],
    );
    expect(created.body.state).toMatchObject({
      source: "gpc",
      purposes: DENIED,
    });
    const result = await accept(
      client().updateAnonymous({
        headers: { ...tokenHeaders(created.body.token), "sec-gpc": "1" },
        body: explicit(created.body.state.revision),
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      source: "gpc",
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    });
  });

  it("allows a new explicit opt-in using the current revision after GPC is absent", async () => {
    const created = await browser({ source: "gpc" });
    const optedIn = await accept(
      client().updateAnonymous({
        headers: tokenHeaders(created.token),
        body: explicit(created.state.revision),
      }),
      [200],
    );
    expect(optedIn.body).toMatchObject({
      source: "explicit",
      purposes: GRANTED,
      advertisingAllowed: true,
      marketingAnalyticsAllowed: true,
    });
    expect(optedIn.body.revision).not.toBe(created.state.revision);
  });

  it("retains a withdrawal when a grant and withdrawal arrive concurrently", async () => {
    const created = await browser();
    const headers = tokenHeaders(created.token);
    const results = await Promise.all([
      client().updateAnonymous({
        headers,
        body: explicit(created.state.revision),
      }),
      client().updateAnonymous({
        headers,
        body: explicit(created.state.revision, DENIED),
      }),
    ]);
    expect([200, 409]).toContain(results[0].status);
    expect(results[1].status).toBe(200);
    const read = await accept(client().getAnonymous({ headers }), [200]);
    expect(read.body).toMatchObject({
      purposes: DENIED,
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    });
  });

  it("imports the latest anonymous withdrawal and keeps the linked browser on the personal state", async () => {
    const created = await browser(explicit(null));
    await accept(
      client().updateAnonymous({
        headers: tokenHeaders(created.token),
        body: { source: "gpc" },
      }),
      [200],
    );
    const userId = signIn();
    const linked = await associate(created.token);
    expect(linked.body).toMatchObject({ purposes: DENIED, source: "gpc" });
    expect(JSON.stringify(linked.body)).not.toContain(userId);
    const read = await accept(
      client().getAnonymous({ headers: tokenHeaders(created.token) }),
      [200],
    );
    expect(read.body).toStrictEqual(linked.body);
    expect(
      (
        await client().updateAnonymous({
          headers: tokenHeaders(created.token),
          body: explicit(created.state.revision),
        })
      ).status,
    ).toBe(409);
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body,
    ).toStrictEqual(linked.body);
  });

  it("can establish a new person's consent from a verified anonymous choice", async () => {
    const created = await browser(explicit(null));
    signIn();
    const linked = await associate(created.token);
    expect(linked.body).toMatchObject({
      purposes: GRANTED,
      source: "explicit",
      advertisingAllowed: true,
    });
    expect(linked.body.revision).not.toBe(created.state.revision);
    expect((await associate(created.token)).body).toStrictEqual(linked.body);
  });

  it("never restores an existing withdrawal by associating an older granted browser", async () => {
    const created = await browser(explicit(null));
    signIn();
    const withdrawn = await accept(
      client().update({ headers: sessionHeaders, body: { source: "gpc" } }),
      [200],
    );
    const linked = await associate(created.token);
    expect(linked.body).toStrictEqual(withdrawn.body);
  });

  it("propagates a later anonymous withdrawal to the previously linked person", async () => {
    const created = await browser(explicit(null));
    signIn();
    const linked = await associate(created.token);
    await accept(
      client().updateAnonymous({
        headers: tokenHeaders(created.token),
        body: explicit(linked.body.revision, DENIED),
      }),
      [200],
    );
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body,
    ).toMatchObject({ purposes: DENIED, advertisingAllowed: false });
  });

  it("applies GPC during association even when the browser previously granted consent", async () => {
    const created = await browser(explicit(null));
    signIn();
    const linked = await accept(
      client().associate({
        headers: { ...sessionHeaders, "sec-gpc": "1" },
        body: { anonymousToken: created.token },
      }),
      [200],
    );
    expect(linked.body).toMatchObject({ source: "gpc", purposes: DENIED });
  });

  it("keeps withdrawals when two browsers associate with the same person concurrently", async () => {
    const allowed = await browser(explicit(null));
    const denied = await browser({ source: "gpc" });
    signIn();
    await Promise.all([associate(allowed.token), associate(denied.token)]);
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body,
    ).toMatchObject({ source: "gpc", purposes: DENIED });
  });

  it("scopes choices to the person across organizations and rejects rebinding to another person", async () => {
    const created = await browser({ source: "gpc" });
    const first = signIn();
    const linked = await associate(created.token);
    signIn(first, `org_${randomUUID()}`);
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body,
    ).toStrictEqual(linked.body);
    signIn();
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body
        .advertisingAllowed,
    ).toBeFalsy();
    expect(
      (
        await client().associate({
          headers: sessionHeaders,
          body: { anonymousToken: created.token },
        })
      ).status,
    ).toBe(409);
  });

  it("persists GPC on personal reads and rejects stale personal grants", async () => {
    signIn();
    const initial = await accept(
      client().update({ headers: sessionHeaders, body: explicit(null) }),
      [200],
    );
    const withdrawn = await accept(
      client().get({ headers: { ...sessionHeaders, "sec-gpc": "1" } }),
      [200],
    );
    expect(withdrawn.body).toMatchObject({ source: "gpc", purposes: DENIED });
    expect(
      (
        await client().update({
          headers: sessionHeaders,
          body: explicit(initial.body.revision),
        })
      ).status,
    ).toBe(409);
    expect(
      (await accept(client().get({ headers: sessionHeaders }), [200])).body,
    ).toStrictEqual(withdrawn.body);
  });

  it("rejects unverified legacy consent and attribution payloads without changing a saved withdrawal", async () => {
    const created = await browser({ source: "gpc" });
    const raw = setupRawAppRequest({ context, routes: privacyChoicesRoutes });
    for (const body of [
      {
        source: "explicit",
        policyVersion: "old",
        expectedRevision: created.state.revision,
        purposes: GRANTED,
      },
      {
        source: "explicit",
        policyVersion: PRIVACY_POLICY_VERSION,
        purposes: GRANTED,
      },
      { ...explicit(created.state.revision), gclid: "not-consent-evidence" },
      {
        ...explicit(created.state.revision),
        purposes: { ...GRANTED, advertising: true },
      },
    ]) {
      const response = await raw(
        "http://api.test/api/privacy-choices/anonymous",
        {
          method: "PUT",
          headers: {
            ...tokenHeaders(created.token),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await accept(
          client().getAnonymous({ headers: tokenHeaders(created.token) }),
          [200],
        )
      ).body,
    ).toStrictEqual(created.state);
  });
});
