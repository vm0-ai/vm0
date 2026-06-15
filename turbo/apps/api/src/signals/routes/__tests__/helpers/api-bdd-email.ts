import { randomUUID } from "node:crypto";

import { cronDrainEmailOutboxContract } from "@vm0/api-contracts/contracts/cron";
import { zeroEmailInboundContract } from "@vm0/api-contracts/contracts/zero-email";
import { Webhook } from "svix";

import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";

const CRON_AUTHORIZATION = "Bearer test-cron-secret";
const RESEND_WEBHOOK_SECRET = "whsec_test";

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
      setupApp({ context })(zeroEmailInboundContract).post({
        headers: resendSvixHeaders(JSON.stringify(event)),
        body: event,
      }),
      statuses,
    );
  }

  return {
    postResendInboundWebhook,

    /**
     * Induce a pending email outbox row through public state only: an inbound
     * email from a sender with no vm0 account makes the inbound webhook enqueue
     * an inbound-error reply, and a rejecting Resend mock rolls back the inline
     * drain so the row stays pending for the drain cron.
     */
    async triggerInboundErrorEmail(
      opts: { readonly from?: string; readonly subject?: string } = {},
    ): Promise<{ readonly from: string; readonly subject: string }> {
      const from =
        opts.from ?? `bdd-sender-${randomUUID().slice(0, 12)}@example.test`;
      const subject = opts.subject ?? `BDD drain ${randomUUID().slice(0, 8)}`;
      context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
      context.mocks.resend.send.mockRejectedValue(
        new Error("inline drain down"),
      );
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
    },

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
        setupApp({ context })(cronDrainEmailOutboxContract).drain({
          headers: validAuth ? { authorization: CRON_AUTHORIZATION } : {},
        }),
        [200, 401],
      );
    },
  };
}
