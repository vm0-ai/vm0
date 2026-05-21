import { createHmac, randomUUID } from "node:crypto";

import { zeroIntegrationsWhatsAppContract } from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { whatsappMessages } from "@vm0/db/schema/whatsapp-message";
import { whatsappUserLinks } from "@vm0/db/schema/whatsapp-user-link";
import { whatsappVerificationSendCooldowns } from "@vm0/db/schema/whatsapp-verification-send-cooldown";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { signWhatsAppConnectParams } from "../../services/zero-whatsapp.service";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

interface TwilioSendCall {
  readonly accountSid: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly body: string | null;
}

const WEBHOOK_URL = "http://api.test/api/integrations/twilio/webhook";
const TWILIO_AUTH_TOKEN = "twilio-test-token";
const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);

const trackPhone = createFixtureTracker(
  async (fixture: { readonly phoneHandle: string }) => {
    await writeDb
      .delete(whatsappMessages)
      .where(eq(whatsappMessages.phoneHandle, fixture.phoneHandle));
    await writeDb
      .delete(whatsappUserLinks)
      .where(eq(whatsappUserLinks.phoneHandle, fixture.phoneHandle));
  },
);

const trackVerificationSendCooldown = createFixtureTracker(
  async (fixture: { readonly scope: string; readonly scopeKey: string }) => {
    await writeDb
      .delete(whatsappVerificationSendCooldowns)
      .where(
        and(
          eq(whatsappVerificationSendCooldowns.scope, fixture.scope),
          eq(whatsappVerificationSendCooldowns.scopeKey, fixture.scopeKey),
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function setupWhatsAppUser(): {
  readonly userId: string;
  readonly orgId: string;
} {
  const userId = uniqueId("user");
  const orgId = uniqueId("org");
  mocks.clerk.session(userId, orgId);
  mockEnv("APP_URL", "http://localhost:3002");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  mockOptionalEnv("TWILIO_ACCOUNT_SID", "ACtest");
  mockOptionalEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
  mockOptionalEnv("TWILIO_WHATSAPP_FROM_NUMBER", "+19039853128");
  mockOptionalEnv("TWILIO_WHATSAPP_WEBHOOK_URL", WEBHOOK_URL);
  return { userId, orgId };
}

async function insertWhatsAppUserLink(params: {
  readonly phoneHandle: string;
  readonly vm0UserId: string;
  readonly orgId: string;
}): Promise<void> {
  await writeDb.insert(whatsappUserLinks).values(params);
  await trackPhone(Promise.resolve({ phoneHandle: params.phoneHandle }));
}

async function trackWhatsAppVerificationCooldowns(params: {
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

async function findWhatsAppUserLink(phoneHandle: string) {
  const [row] = await writeDb
    .select()
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  return row;
}

async function readWhatsAppMessage(messageSid: string) {
  const [row] = await writeDb
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.twilioMessageSid, messageSid))
    .limit(1);
  return row;
}

function twilioSendMessage() {
  const calls: TwilioSendCall[] = [];
  const handler = http.post(
    "https://api.twilio.com/2010-04-01/Accounts/:accountSid/Messages.json",
    async ({ params, request }) => {
      const text = await request.text();
      const body = new URLSearchParams(text);
      calls.push({
        accountSid: String(params.accountSid),
        from: body.get("From"),
        to: body.get("To"),
        body: body.get("Body"),
      });
      return HttpResponse.json({
        sid: uniqueId("SM"),
        status: "queued",
        from: body.get("From"),
        to: body.get("To"),
        body: body.get("Body"),
      });
    },
  );
  return { handler, calls };
}

function signTwilioWebhook(form: URLSearchParams): string {
  const signed = [...form.entries()]
    .sort((left, right) => {
      if (left[0] !== right[0]) {
        return left[0] < right[0] ? -1 : 1;
      }
      if (left[1] === right[1]) {
        return 0;
      }
      return left[1] < right[1] ? -1 : 1;
    })
    .reduce((acc, [key, value]) => {
      return `${acc}${key}${value}`;
    }, WEBHOOK_URL);
  return createHmac("sha1", TWILIO_AUTH_TOKEN).update(signed).digest("base64");
}

function postTwilioWebhook(form: URLSearchParams): Promise<Response> {
  return Promise.resolve(
    createApp({ signal: context.signal }).request(
      "/api/integrations/twilio/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signTwilioWebhook(form),
        },
        body: form.toString(),
      },
    ),
  );
}

describe("WhatsApp integration routes", () => {
  it("returns the current linked WhatsApp handle", async () => {
    const user = setupWhatsAppUser();
    const phone = uniquePhone();
    await insertWhatsAppUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const client = setupApp({ context })(zeroIntegrationsWhatsAppContract);

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      linked: true,
      phoneHandle: phone,
      whatsAppNumber: "+19039853128",
      configured: true,
    });
  });

  it("sends a signed verification link and does not silently link the phone", async () => {
    const user = setupWhatsAppUser();
    await trackWhatsAppVerificationCooldowns({
      ...user,
      phoneHandles: ["+15555551212"],
    });
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const client = setupApp({ context })(zeroIntegrationsWhatsAppContract);

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
        accountSid: "ACtest",
        from: "whatsapp:+19039853128",
        to: "whatsapp:+15555551212",
      }),
    );
    expect(sendMessage.calls[0]?.body).toContain("/whatsapp/connect?");
    await expect(findWhatsAppUserLink("+15555551212")).resolves.toBeUndefined();
  });

  it("connects a signed WhatsApp link for the authenticated user", async () => {
    const user = setupWhatsAppUser();
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const client = setupApp({ context })(zeroIntegrationsWhatsAppContract);
    const phoneHandle = uniquePhone();
    await trackPhone(Promise.resolve({ phoneHandle }));
    const timestamp = currentSecond();

    const response = await accept(
      client.connectWhatsApp({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          phoneHandle,
          timestamp,
          signature: signWhatsAppConnectParams({
            phoneHandle,
            timestamp,
            secret: "a".repeat(64),
          }),
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ phoneHandle });
    await expect(findWhatsAppUserLink(phoneHandle)).resolves.toMatchObject({
      phoneHandle,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    expect(sendMessage.calls.at(-1)).toStrictEqual(
      expect.objectContaining({
        to: `whatsapp:${phoneHandle}`,
      }),
    );
  });

  it("verifies Twilio signatures before accepting inbound WhatsApp messages", async () => {
    setupWhatsAppUser();
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const form = new URLSearchParams({
      MessageSid: uniqueId("SM"),
      From: "whatsapp:+15555551212",
      To: "whatsapp:+19039853128",
      Body: "/connect",
      NumMedia: "0",
    });
    await trackPhone(Promise.resolve({ phoneHandle: "+15555551212" }));

    const rejected = await createApp({ signal: context.signal }).request(
      "/api/integrations/twilio/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "bad-signature",
        },
        body: form.toString(),
      },
    );
    expect(rejected.status).toBe(401);

    const accepted = await postTwilioWebhook(form);
    expect(accepted.status).toBe(200);
    await clearAllDetached();

    await expect(
      readWhatsAppMessage(form.get("MessageSid") ?? ""),
    ).resolves.toMatchObject({
      phoneHandle: "+15555551212",
      fromNumber: "+15555551212",
      toNumber: "+19039853128",
      direction: "inbound",
      body: "/connect",
    });
    expect(sendMessage.calls.at(-1)?.body).toContain("/whatsapp/connect?");
  });
});
