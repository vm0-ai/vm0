import { randomUUID } from "node:crypto";

import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { agentphoneVerificationSendCooldowns } from "@vm0/db/schema/agentphone-verification-send-cooldown";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-integrations-agentphone-link.test.ts`. The 10
// legacy `it()`s collapse into 3 BDD `it()`s:
// (1) auth + link status + disconnect chain (401
// unauthenticated → 200 returns the current linked
// handle → 204 disconnect clears the link),
// (2) start link + rate limit chain (200 sends a
// signed verification link → 429 rate-limits the next
// call from the same user),
// (3) validation + error logging chain (400 empty
// normalized input → 400 missing country code → 409
// already linked to another owner → 503 provider
// rejected with warn log → 503 fetch failure with
// error log).

interface AgentPhoneSendMessageBody {
  readonly agent_id: string;
  readonly to_number: string;
  readonly body: string;
}

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);

const trackPhone = createFixtureTracker(
  async (fixture: { readonly phoneHandle: string }) => {
    await writeDb
      .delete(agentphoneUserLinks)
      .where(eq(agentphoneUserLinks.phoneHandle, fixture.phoneHandle));
  },
);

const trackVerificationSendCooldown = createFixtureTracker(
  async (fixture: { readonly scope: string; readonly scopeKey: string }) => {
    await writeDb
      .delete(agentphoneVerificationSendCooldowns)
      .where(
        and(
          eq(agentphoneVerificationSendCooldowns.scope, fixture.scope),
          eq(agentphoneVerificationSendCooldowns.scopeKey, fixture.scopeKey),
        ),
      );
  },
);

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function uniquePhone(): string {
  const digits = randomUUID().replace(/\D/gu, "").padEnd(7, "0").slice(0, 7);
  return `+1555${digits}`;
}

function setupAgentPhoneUser(): {
  readonly userId: string;
  readonly orgId: string;
} {
  const userId = uniqueId("user");
  const orgId = uniqueId("org");
  mocks.clerk.session(userId, orgId);
  mockOptionalEnv("AGENTPHONE_AGENT_ID", "agt-test-agentphone");
  mockOptionalEnv("AGENTPHONE_API_BASE_URL", "https://api.agentphone.to");
  mockOptionalEnv("AGENTPHONE_API_KEY", "agentphone-test-key");
  mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", "+19039853128");
  return { userId, orgId };
}

async function insertAgentPhoneUserLink(params: {
  readonly phoneHandle: string;
  readonly vm0UserId: string;
  readonly orgId: string;
}): Promise<void> {
  await writeDb.insert(agentphoneUserLinks).values(params);
  await trackPhone(Promise.resolve({ phoneHandle: params.phoneHandle }));
}

async function trackAgentPhoneVerificationCooldowns(params: {
  readonly userId: string;
  readonly orgId: string;
  readonly phoneHandles: readonly string[];
}): Promise<void> {
  await trackVerificationSendCooldown(
    Promise.resolve({
      scope: "user_org",
      scopeKey: `${params.orgId}:${params.userId}`,
    }),
  );
  for (const phoneHandle of params.phoneHandles) {
    await trackVerificationSendCooldown(
      Promise.resolve({ scope: "phone", scopeKey: phoneHandle }),
    );
  }
}

async function findAgentPhoneUserLink(phoneHandle: string) {
  const [row] = await writeDb
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  return row;
}

function agentPhoneSendMessage() {
  const calls: AgentPhoneSendMessageBody[] = [];
  const handler = http.post(
    "https://api.agentphone.to/v1/messages",
    async ({ request }) => {
      const body = (await request.json()) as AgentPhoneSendMessageBody;
      calls.push(body);
      return HttpResponse.json({
        id: uniqueId("apmsg"),
        status: "sent",
        channel: "sms",
        from_number: "+19039853128",
        to_number: body.to_number,
      });
    },
  );
  return { handler, calls };
}

function apiClient() {
  return setupApp({ context })(zeroIntegrationsAgentPhoneContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD /api/integrations/agentphone/link — auth + link status + disconnect chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 200 returns the current linked handle → 204 disconnect clears the link", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().getLinkStatus({ headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a user session + an existing link row for
    // that user.

    // When + Then: 200 — link status reports
    // linked=true + the phone handle + the agent phone
    // number + configured=true.
    const linkedUser = setupAgentPhoneUser();
    const linkedPhone = uniquePhone();
    await insertAgentPhoneUserLink({
      phoneHandle: linkedPhone,
      vm0UserId: linkedUser.userId,
      orgId: linkedUser.orgId,
    });
    const linkStatusResponse = await accept(
      apiClient().getLinkStatus({ headers: sessionHeaders() }),
      [200],
    );
    expect(linkStatusResponse.body).toStrictEqual({
      linked: true,
      phoneHandle: linkedPhone,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    // Given: the same user + the same linked phone.

    // When + Then: 204 — unlink succeeds with an
    // empty body + the link row is removed + the
    // agentphone:changed realtime event is published
    // with a null payload.
    const disconnectResponse = await accept(
      apiClient().unlink({ headers: sessionHeaders() }),
      [204],
    );
    expect(disconnectResponse.body).toBeUndefined();
    await expect(findAgentPhoneUserLink(linkedPhone)).resolves.toBeUndefined();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "agentphone:changed",
      null,
    );
  });
});

describe("BDD POST /api/integrations/agentphone/link — start link + rate limit chain", () => {
  it("gwt-wt-wt: 200 sends a signed verification link → 429 rate-limits the next call from the same user", async () => {
    // Given: a fresh user + cooldowns tracked for
    // that user + the AgentPhone MSW handler
    // returning 200.

    // When + Then: 200 — the response body echoes the
    // normalized phoneHandle + the SMS is sent with
    // the expected agent_id and to_number + the body
    // contains the signed connect URL + the link row
    // is NOT created (verification-first flow).
    const firstUser = setupAgentPhoneUser();
    await trackAgentPhoneVerificationCooldowns({
      ...firstUser,
      phoneHandles: ["+15555551212"],
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const startLinkResponse = await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: "+1 (555) 555-1212" },
      }),
      [200],
    );
    expect(startLinkResponse.body).toStrictEqual({
      phoneHandle: "+15555551212",
      verificationSent: true,
    });
    expect(sendMessage.calls).toHaveLength(1);
    expect(sendMessage.calls[0]).toStrictEqual(
      expect.objectContaining({
        agent_id: "agt-test-agentphone",
        to_number: "+15555551212",
      }),
    );
    expect(sendMessage.calls[0]?.body).toContain("/agentphone/connect?");
    expect(sendMessage.calls[0]?.body).toContain(
      "http://localhost:3002/agentphone/connect?",
    );
    await expect(
      findAgentPhoneUserLink("+15555551212"),
    ).resolves.toBeUndefined();

    // Given: a fresh user + cooldowns tracked for
    // that user + a single send handler.

    // When + Then: 200 on the first call + 429 on the
    // second call from the same user (rate limit
    // fires) + only one outbound SMS was sent.
    const rateUser = setupAgentPhoneUser();
    const firstPhone = uniquePhone();
    const secondPhone = uniquePhone();
    await trackAgentPhoneVerificationCooldowns({
      ...rateUser,
      phoneHandles: [firstPhone, secondPhone],
    });
    const rateSendMessage = agentPhoneSendMessage();
    server.use(rateSendMessage.handler);

    await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: firstPhone },
      }),
      [200],
    );

    const rateLimitResponse = await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: secondPhone },
      }),
      [429],
    );
    expect(rateLimitResponse.body).toStrictEqual({
      error: {
        message:
          "Verification text was just sent. Wait a minute before trying again.",
        code: "TOO_MANY_REQUESTS",
      },
    });
    expect(rateSendMessage.calls).toHaveLength(1);
  });
});

describe("BDD POST /api/integrations/agentphone/link — validation + error logging chain", () => {
  it("gwt-wt-wt: 400 empty normalized input → 400 missing country code → 409 already linked to another owner → 503 provider rejected with warn log → 503 fetch failure with error log", async () => {
    // Given: a user session + a body whose
    // normalized form has no digits.

    // When + Then: 400 — BAD_REQUEST.
    setupAgentPhoneUser();
    const emptyResponse = await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: "abc" },
      }),
      [400],
    );
    expect(emptyResponse.body).toStrictEqual({
      error: expect.objectContaining({ code: "BAD_REQUEST" }),
    });

    // Given: a user session + a phone that does not
    // start with `+`.

    // When + Then: 400 — friendly error message
    // about the country code.
    setupAgentPhoneUser();
    const noCountryCodeResponse = await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: "555-555-1212" },
      }),
      [400],
    );
    expect(noCountryCodeResponse.body).toStrictEqual({
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Enter a phone number with country code, like +1 555 555 1212",
      }),
    });

    // Given: a user session + a phone that is
    // already linked to a different user.

    // When + Then: 409 — CONFLICT.
    setupAgentPhoneUser();
    const alreadyLinkedPhone = uniquePhone();
    await insertAgentPhoneUserLink({
      phoneHandle: alreadyLinkedPhone,
      vm0UserId: uniqueId("existing-user"),
      orgId: uniqueId("existing-org"),
    });
    const conflictResponse = await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: alreadyLinkedPhone },
      }),
      [409],
    );
    expect(conflictResponse.body).toStrictEqual({
      error: expect.objectContaining({ code: "CONFLICT" }),
    });

    // Given: a user session + cooldowns tracked +
    // the AgentPhone MSW handler returning 429 with
    // a text body.

    // When + Then: 503 — PROVIDER_UNAVAILABLE + a
    // warn log capturing the masked phone, the
    // status, the status text, and the body.
    const providerUser = setupAgentPhoneUser();
    const providerPhone = uniquePhone();
    await trackAgentPhoneVerificationCooldowns({
      ...providerUser,
      phoneHandles: [providerPhone],
    });
    server.use(
      http.post("https://api.agentphone.to/v1/messages", () => {
        return HttpResponse.text("provider quota exceeded", { status: 429 });
      }),
    );
    const providerResponse = await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: providerPhone },
      }),
      [503],
    );
    expect(providerResponse.body).toStrictEqual({
      error: {
        message: "AgentPhone verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      "AgentPhone verification text provider rejected send",
      expect.objectContaining({
        agentphoneAgentId: "agt-test-agentphone",
        phoneHandle: `***${providerPhone.slice(-4)}`,
        status: 429,
        statusText: "Too Many Requests",
        body: "provider quota exceeded",
        context: "api:agentphone:link",
      }),
    );

    // Given: a user session + cooldowns tracked +
    // the AgentPhone MSW handler returning a network
    // error.

    // When + Then: 503 + an error log capturing the
    // masked phone + the agent id + a serializable
    // error object.
    const fetchUser = setupAgentPhoneUser();
    const fetchPhone = uniquePhone();
    await trackAgentPhoneVerificationCooldowns({
      ...fetchUser,
      phoneHandles: [fetchPhone],
    });
    server.use(
      http.post("https://api.agentphone.to/v1/messages", () => {
        return HttpResponse.error();
      }),
    );
    await accept(
      apiClient().startLink({
        headers: sessionHeaders(),
        body: { phoneHandle: fetchPhone },
      }),
      [503],
    );
    expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
      "AgentPhone verification text send failed",
      expect.objectContaining({
        agentphoneAgentId: "agt-test-agentphone",
        phoneHandle: `***${fetchPhone.slice(-4)}`,
        context: "api:agentphone:link",
        error: expect.objectContaining({
          message: expect.any(String),
        }),
      }),
    );
  });
});
