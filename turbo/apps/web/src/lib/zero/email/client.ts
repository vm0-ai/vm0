import { Resend } from "resend";
import { env } from "../../../env";
import type { SendEmailDirectOptions } from "./types";

let resendInstance: Resend | undefined;

function getResendClient(): Resend {
  if (!resendInstance) {
    const apiKey = env().RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    resendInstance = new Resend(apiKey);
  }
  return resendInstance;
}

type SendDirectResult =
  | { ok: true; resendId: string }
  | { ok: false; error: string };

/**
 * Send an email directly via Resend. Used only by the outbox drain worker.
 * Does NOT retrieve the RFC Message-ID — the drain worker handles that
 * separately via getMessageId() when a post-send action requires it.
 */
export async function sendEmailDirect(
  options: SendEmailDirectOptions,
): Promise<SendDirectResult> {
  const resend = getResendClient();

  const { data, error } = await resend.emails.send({
    from: options.from,
    to: options.to,
    subject: options.subject,
    react: options.react,
    cc: options.cc,
    replyTo: options.replyTo,
    headers: options.headers,
  });

  if (error || !data) {
    return { ok: false, error: error?.message ?? "unknown" };
  }

  return { ok: true, resendId: data.id };
}

/**
 * Retrieve the RFC Message-ID for a sent email.
 * Used by the outbox drain worker after sending, when email threading is needed.
 * Returns null on failure (graceful degradation — threading is best-effort).
 */
export async function getMessageId(resendId: string): Promise<string | null> {
  const resend = getResendClient();

  const { data, error } = await resend.emails.get(resendId);

  if (error || !data) {
    return null;
  }

  return "message_id" in data && typeof data.message_id === "string"
    ? data.message_id
    : null;
}
