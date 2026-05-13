import { randomUUID } from "node:crypto";

import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentphoneVerificationSendCooldowns } from "@vm0/db/schema/agentphone-verification-send-cooldown";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
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

const trackSwitch = createFixtureTracker(
  async (fixture: { readonly orgId: string; readonly userId: string }) => {
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
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

async function enableAgentPhoneUi(
  orgId: string,
  userId: string,
): Promise<void> {
  await writeDb
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches: { [FeatureSwitchKey.AgentPhoneAppUi]: true } },
    });
  await trackSwitch(Promise.resolve({ orgId, userId }));
}

async function setupEnabledUser(): Promise<{
  readonly userId: string;
  readonly orgId: string;
}> {
  const userId = uniqueId("user");
  const orgId = uniqueId("org");
  mocks.clerk.session(userId, orgId);
  await enableAgentPhoneUi(orgId, userId);
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

describe("/api/integrations/agentphone/link", () => {
  it("hides the link API when the AgentPhone UI switch is disabled", async () => {
    mocks.clerk.session(uniqueId("user"), uniqueId("org"));
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "AgentPhone app UI is not enabled",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns the current linked phone handle", async () => {
    const user = await setupEnabledUser();
    const phone = uniquePhone();
    await insertAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      linked: true,
      phoneHandle: phone,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
  });

  it("sends a signed verification link and does not silently link the phone", async () => {
    const user = await setupEnabledUser();
    await trackAgentPhoneVerificationCooldowns({
      ...user,
      phoneHandles: ["+15555551212"],
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: "+1 (555) 555-1212" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
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
  });

  it("rate limits consecutive verification texts for the same user", async () => {
    const user = await setupEnabledUser();
    const firstPhone = uniquePhone();
    const secondPhone = uniquePhone();
    await trackAgentPhoneVerificationCooldowns({
      ...user,
      phoneHandles: [firstPhone, secondPhone],
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: firstPhone },
      }),
      [200],
    );

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: secondPhone },
      }),
      [429],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Verification text was just sent. Wait a minute before trying again.",
        code: "TOO_MANY_REQUESTS",
      },
    });
    expect(sendMessage.calls).toHaveLength(1);
  });

  it("logs provider details when verification text sending is rejected", async () => {
    const user = await setupEnabledUser();
    const phone = uniquePhone();
    await trackAgentPhoneVerificationCooldowns({
      ...user,
      phoneHandles: [phone],
    });
    server.use(
      http.post("https://api.agentphone.to/v1/messages", () => {
        return HttpResponse.text("provider quota exceeded", { status: 429 });
      }),
    );
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: phone },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "AgentPhone verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      "AgentPhone verification text provider rejected send",
      expect.objectContaining({
        agentphoneAgentId: "agt-test-agentphone",
        phoneHandle: `***${phone.slice(-4)}`,
        status: 429,
        statusText: "Too Many Requests",
        body: "provider quota exceeded",
        context: "api:agentphone:link",
      }),
    );
  });

  it("logs fetch failures when verification text sending fails before response", async () => {
    const user = await setupEnabledUser();
    const phone = uniquePhone();
    await trackAgentPhoneVerificationCooldowns({
      ...user,
      phoneHandles: [phone],
    });
    server.use(
      http.post("https://api.agentphone.to/v1/messages", () => {
        return HttpResponse.error();
      }),
    );
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: phone },
      }),
      [503],
    );

    expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
      "AgentPhone verification text send failed",
      expect.objectContaining({
        agentphoneAgentId: "agt-test-agentphone",
        phoneHandle: `***${phone.slice(-4)}`,
        context: "api:agentphone:link",
        error: expect.objectContaining({
          message: expect.any(String),
        }),
      }),
    );
  });

  it("rejects empty normalized phone input", async () => {
    await setupEnabledUser();
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: "abc" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: expect.objectContaining({ code: "BAD_REQUEST" }),
    });
  });

  it("rejects phone input without an explicit country code", async () => {
    await setupEnabledUser();
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: "555-555-1212" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Enter a phone number with country code, like +1 555 555 1212",
      }),
    });
  });

  it("rejects a phone handle already linked to another owner", async () => {
    await setupEnabledUser();
    const phone = uniquePhone();
    await insertAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: uniqueId("existing-user"),
      orgId: uniqueId("existing-org"),
    });
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: phone },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: expect.objectContaining({ code: "CONFLICT" }),
    });
  });

  it("disconnects the authenticated user's linked phone", async () => {
    const user = await setupEnabledUser();
    const phone = uniquePhone();
    await insertAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.unlink({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();
    await expect(findAgentPhoneUserLink(phone)).resolves.toBeUndefined();
  });

  it("requires authentication", async () => {
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(client.getLinkStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });
});
