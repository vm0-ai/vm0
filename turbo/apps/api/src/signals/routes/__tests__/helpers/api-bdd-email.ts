import { randomUUID } from "node:crypto";

import { cronDrainEmailOutboxContract } from "@vm0/api-contracts/contracts/cron";
import { zeroEmailInboundContract } from "@vm0/api-contracts/contracts/zero-email";
import { Webhook } from "svix";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { now } from "../../../../lib/time";
import { cronDrainEmailOutboxRoutes } from "../../cron-drain-email-outbox";
import { zeroEmailInboundRoutes } from "../../zero-email-inbound";

const CRON_AUTHORIZATION = "Bearer test-cron-secret";
const RESEND_WEBHOOK_SECRET = "whsec_test";

const emailRoutes = [
  ...zeroEmailInboundRoutes,
  ...cronDrainEmailOutboxRoutes,
] as const;

function emailApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: emailRoutes });
}

interface SvixHeaders {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
}

function resendSvixHeaders(rawBody: string): SvixHeaders {
  const id = `msg_${randomUUID()}`;
  const timestamp = new Date(now());
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(RESEND_WEBHOOK_SECRET).sign(
      id,
      timestamp,
      rawBody,
    ),
  };
}

export function createEmailApi(context: TestContext) {
  async function postResendInboundWebhook(
    event: unknown,
    statuses: readonly (200 | 401)[],
  ) {
    return await accept(
      emailApp(context)(zeroEmailInboundContract).post({
        headers: resendSvixHeaders(JSON.stringify(event)),
        body: event,
      }),
      statuses,
    );
  }

  async function enqueueInboundErrorEmail(
    opts: { readonly from?: string; readonly subject?: string } = {},
  ): Promise<{ readonly from: string; readonly subject: string }> {
    const from =
      opts.from ?? `bdd-sender-${randomUUID().slice(0, 12)}@example.test`;
    const subject = opts.subject ?? `BDD drain ${randomUUID().slice(0, 8)}`;
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    await postResendInboundWebhook(
      {
        type: "email.received",
        data: {
          email_id: `em_${randomUUID()}`,
          to: ["bdd-org@mail.example.com"],
          from,
          subject,
        },
      },
      [200],
    );
    return { from, subject };
  }

  return {
    postResendInboundWebhook,
    enqueueInboundErrorEmail,

    async suppressEmailAddress(address: string): Promise<void> {
      await postResendInboundWebhook(
        {
          type: "email.bounced",
          data: { email_id: `em_${randomUUID()}`, to: [address] },
        },
        [200],
      );
    },

    async drainEmailOutboxCron(validAuth: boolean) {
      return await accept(
        emailApp(context)(cronDrainEmailOutboxContract).drain({
          headers: validAuth ? { authorization: CRON_AUTHORIZATION } : {},
        }),
        [200, 401],
      );
    },
  };
}
