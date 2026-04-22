import { env } from "../../../../env";
import { enqueueEmail } from "../outbox-service";
import {
  buildFromAddress,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
} from "./shared";

/**
 * Send an error reply email to the sender when inbound processing fails.
 * No-ops when Resend is not configured.
 * When userId is provided, includes List-Unsubscribe headers and template link.
 */
export async function sendInboundErrorReply(opts: {
  to: string;
  subject: string;
  errorMessage: string;
  userId?: string;
}): Promise<void> {
  if (!env().RESEND_API_KEY) return;

  const reSubject = opts.subject
    ? `Re: ${opts.subject.replace(/^Re:\s*/i, "")}`
    : "Email delivery failed";

  const unsubscribeUrl = opts.userId
    ? buildUnsubscribeUrl(opts.userId)
    : undefined;
  const headers = unsubscribeUrl
    ? buildUnsubscribeHeaders(unsubscribeUrl)
    : undefined;

  await enqueueEmail({
    from: buildFromAddress("vm0"),
    to: opts.to,
    subject: reSubject,
    template: {
      template: "inbound-error",
      props: { errorMessage: opts.errorMessage, unsubscribeUrl },
    },
    headers,
  });
}
