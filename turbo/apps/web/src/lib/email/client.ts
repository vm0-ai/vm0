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
}> {
  const resend = getResendClient();

  // Workaround: Resend SDK v4 has `emails.receiving.get()` at runtime but
  // does not expose it in its TypeScript types. Track as tech debt.
  const emails = resend.emails as unknown as Record<string, unknown>;
  const receiving = emails?.receiving as
    | {
        get: (id: string) => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      }
    | undefined;
  if (!receiving?.get) {
    throw new Error("Resend SDK does not support emails.receiving.get");
  }

  const { data, error } = await receiving.get(emailId);

  if (error || !data) {
    throw new Error(
      `Failed to get received email: ${error?.message ?? "unknown"}`,
    );
  }

  return {
    from: String(data.from ?? ""),
    to: Array.isArray(data.to) ? data.to.map(String) : [String(data.to ?? "")],
    subject: String(data.subject ?? ""),
    text: String(data.text ?? ""),
    html: String(data.html ?? ""),
  };
}
