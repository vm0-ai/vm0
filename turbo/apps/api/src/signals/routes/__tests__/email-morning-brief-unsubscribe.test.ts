import { createHmac } from "node:crypto";

import { emailMorningBriefUnsubscribeContract } from "@okouai/api-contracts/contracts/email-morning-brief-unsubscribe";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { emailMorningBriefUnsubscribeRoutes } from "../email-morning-brief-unsubscribe";

const context = testContext();

function client() {
  return setupApp({ context, routes: emailMorningBriefUnsubscribeRoutes })(
    emailMorningBriefUnsubscribeContract,
  );
}

function legacyToken(orgId: string, userId: string): string {
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`morning-brief-unsubscribe:${orgId}:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${orgId}.${userId}.${signature}`;
}

describe("legacy Morning Brief unsubscribe compatibility", () => {
  it("accepts an already-delivered signed link as a terminal no-op", async () => {
    const response = await client().unsubscribe({
      query: { token: legacyToken("org_legacy", "user_legacy") },
    });

    expect(response).toMatchObject({
      status: 200,
      body: { unsubscribed: true },
    });
  });

  it("continues to reject malformed legacy links", async () => {
    const response = await client().unsubscribe({
      query: { token: "invalid" },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: "Invalid token" },
    });
  });
});
