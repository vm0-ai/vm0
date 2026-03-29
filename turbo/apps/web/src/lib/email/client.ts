import { Resend } from "resend";
import { env } from "../../env";
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

/**
 * Retrieve a received inbound email from Resend.
 */
export async function getReceivedEmail(emailId: string): Promise<{
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}> {
  const resend = getResendClient();

  const { data, error } = await resend.emails.receiving.get(emailId);

  if (error || !data) {
    throw new Error(
      `Failed to get received email: ${error?.message ?? "unknown"}`,
    );
  }

  return {
    from: data.from,
    to: data.to,
    cc: data.cc ?? [],
    replyTo: data.reply_to ?? [],
    subject: data.subject,
    text: data.text ?? "",
    html: data.html ?? "",
    headers: data.headers ?? {},
  };
}

export interface ReceivedEmailAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_disposition: string;
  download_url: string;
}

/**
 * List attachments for a received email with download URLs.
 * Download URLs expire after 1 hour.
 */
export async function getReceivedEmailAttachments(
  emailId: string,
): Promise<ReceivedEmailAttachment[]> {
  const resend = getResendClient();

  const { data, error } = await resend.emails.receiving.attachments.list({
    emailId,
  });

  if (error || !data) {
    throw new Error(
      `Failed to list email attachments: ${error?.message ?? "unknown"}`,
    );
  }

  return data.data.map((a) => ({
    id: a.id,
    filename: a.filename ?? `attachment-${a.id}`,
    size: a.size,
    content_type: a.content_type,
    content_disposition: a.content_disposition,
    download_url: a.download_url,
  }));
}
