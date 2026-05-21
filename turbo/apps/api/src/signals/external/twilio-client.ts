import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";

const log = logger("api:twilio");

interface TwilioSentMessage {
  readonly sid: string;
  readonly status: string;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly body: string | null;
}

interface TwilioTypingIndicator {
  readonly success: boolean;
}

interface TwilioApiError extends Error {
  readonly name: "TwilioApiError";
  readonly status: number;
  readonly body: string;
}

function twilioApiBase(): string {
  return optionalEnv("TWILIO_API_BASE_URL") ?? "https://api.twilio.com";
}

function twilioMessagingApiBase(): string {
  return (
    optionalEnv("TWILIO_MESSAGING_API_BASE_URL") ??
    "https://messaging.twilio.com"
  );
}

function twilioAccountSid(): string {
  const accountSid = optionalEnv("TWILIO_ACCOUNT_SID");
  if (!accountSid) {
    throw new Error("TWILIO_ACCOUNT_SID is not configured");
  }
  return accountSid;
}

function twilioAuthToken(): string {
  const authToken = optionalEnv("TWILIO_AUTH_TOKEN");
  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN is not configured");
  }
  return authToken;
}

function makeTwilioApiError(status: number, body: string): TwilioApiError {
  return Object.assign(new Error(`Twilio API error: ${status}`), {
    name: "TwilioApiError" as const,
    status,
    body,
  });
}

export function isTwilioApiError(error: unknown): error is TwilioApiError {
  return (
    error instanceof Error &&
    error.name === "TwilioApiError" &&
    "status" in error
  );
}

function formatWhatsAppAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("whatsapp:")
    ? trimmed
    : `whatsapp:${trimmed}`;
}

function stripWhatsAppAddress(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().replace(/^whatsapp:/iu, "") || null;
}

export async function sendTwilioWhatsAppMessage(
  opts: {
    readonly accountSid?: string;
    readonly authToken?: string;
    readonly fromNumber: string;
    readonly toNumber: string;
    readonly body: string;
  },
  signal?: AbortSignal,
): Promise<TwilioSentMessage> {
  const accountSid = opts.accountSid ?? twilioAccountSid();
  const authToken = opts.authToken ?? twilioAuthToken();
  const form = new URLSearchParams({
    From: formatWhatsAppAddress(opts.fromNumber),
    To: formatWhatsAppAddress(opts.toNumber),
    Body: opts.body,
  });

  const response = await fetch(
    `${twilioApiBase()}/2010-04-01/Accounts/${encodeURIComponent(
      accountSid,
    )}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${accountSid}:${authToken}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    log.error("Twilio WhatsApp send failed", {
      status: response.status,
      body: text,
    });
    throw makeTwilioApiError(response.status, text);
  }

  const result = (await response.json()) as Record<string, unknown>;

  return {
    sid: typeof result.sid === "string" ? result.sid : "unknown",
    status: typeof result.status === "string" ? result.status : "queued",
    fromNumber: stripWhatsAppAddress(result.from) ?? opts.fromNumber,
    toNumber: stripWhatsAppAddress(result.to) ?? opts.toNumber,
    body: typeof result.body === "string" ? result.body : opts.body,
  };
}

export async function sendTwilioWhatsAppTypingIndicator(
  opts: {
    readonly accountSid?: string;
    readonly authToken?: string;
    readonly messageSid: string;
  },
  signal?: AbortSignal,
): Promise<TwilioTypingIndicator> {
  const accountSid = opts.accountSid ?? twilioAccountSid();
  const authToken = opts.authToken ?? twilioAuthToken();
  const form = new URLSearchParams({
    messageId: opts.messageSid,
    channel: "whatsapp",
  });

  const response = await fetch(
    `${twilioMessagingApiBase()}/v2/Indicators/Typing.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${accountSid}:${authToken}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    log.debug("Twilio WhatsApp typing indicator failed", {
      status: response.status,
      body: text,
    });
    throw makeTwilioApiError(response.status, text);
  }

  const result = (await response.json()) as Record<string, unknown>;
  return { success: result.success === true };
}
