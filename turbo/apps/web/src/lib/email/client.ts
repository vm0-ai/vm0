import { Resend } from "resend";
import { env } from "../../env";
import type { ReactElement } from "react";

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

interface SendEmailOptions {
  from: string;
  to: string;
  subject: string;
  react: ReactElement;
  replyTo?: string;
  headers?: Record<string, string>;
}

interface SendEmailResult {
  id: string;
  messageId: string | null;
}

/**
 * Send an email via Resend and retrieve the RFC Message-ID.
 * Resend's send() returns only its internal ID; we call get() to obtain the
 * RFC-compliant message_id needed for In-Reply-To / References threading.
 */
export async function sendEmail(
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const resend = getResendClient();

  const { data, error } = await resend.emails.send({
    from: options.from,
    to: options.to,
    subject: options.subject,
    react: options.react,
    replyTo: options.replyTo,
    headers: options.headers,
  });

  if (error || !data) {
    throw new Error(`Failed to send email: ${error?.message ?? "unknown"}`);
  }

  // Retrieve message_id via get() — send() only returns Resend's internal id
  const { data: emailData, error: getError } = await resend.emails.get(data.id);

  if (getError || !emailData) {
    // Email was sent but we couldn't retrieve the message_id
    return { id: data.id, messageId: null };
  }

  const messageId =
    "message_id" in emailData && typeof emailData.message_id === "string"
      ? emailData.message_id
      : null;

  return { id: data.id, messageId };
}

/**
 * Retrieve a received inbound email from Resend.
 */
export async function getReceivedEmail(emailId: string): Promise<{
  from: string;
  to: string[];
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
    subject: data.subject,
    text: data.text ?? "",
    html: data.html ?? "",
    headers: data.headers,
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
