import { parse } from "smol-toml";
import { z } from "zod";

import { redactSandboxMessage } from "../external/sandbox";
import { safeJsonParse, safeUrlParse, throwIfAbort } from "../utils";

export type StripeCliAuthMode = "test" | "live";

export interface StripeCliAuthStartOutput {
  readonly browserUrl: string;
  readonly pollUrl: string;
  readonly verificationCode: string;
}

const stripeCliAuthOutputSchema = z.object({
  browser_url: z.url(),
  verification_code: z.string().min(1),
  next_step: z.string().min(1),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripeCliAuthPathMatches(url: URL, label: "browser" | "completion") {
  if (label === "browser") {
    return (
      url.pathname === "/stripecli/confirm_auth" ||
      url.pathname.startsWith("/stripecli/confirm_auth/")
    );
  }
  return (
    url.pathname === "/stripecli/auth" ||
    url.pathname.startsWith("/stripecli/auth/")
  );
}

function validateStripeCliAuthUrl(
  url: string,
  label: "browser" | "completion",
): string {
  const parsed = safeUrlParse(url);
  if (!parsed) {
    throw new Error(`Stripe CLI response included an invalid ${label} URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "dashboard.stripe.com" ||
    !stripeCliAuthPathMatches(parsed, label)
  ) {
    throw new Error(`Stripe CLI response included an unexpected ${label} URL`);
  }

  return url;
}

function extractStripeCliAuthPollUrl(nextStep: string): string {
  const quoted = /--complete\s+(['"])(?<url>[^'"]+)\1/.exec(nextStep);
  const unquoted = quoted ?? /--complete\s+(?<url>\S+)/.exec(nextStep);
  const pollUrl = unquoted?.groups?.url;
  if (!pollUrl) {
    throw new Error("Stripe CLI response did not include a completion URL");
  }

  return validateStripeCliAuthUrl(pollUrl, "completion");
}

export function parseStripeCliAuthStartOutput(
  stdout: string,
): StripeCliAuthStartOutput {
  const output = stripeCliAuthOutputSchema.parse(safeJsonParse(stdout));
  const pollUrl = extractStripeCliAuthPollUrl(output.next_step);
  const browserUrl = validateStripeCliAuthUrl(output.browser_url, "browser");

  return {
    browserUrl,
    pollUrl,
    verificationCode: output.verification_code,
  };
}

function stripeCliAuthKeyField(mode: StripeCliAuthMode): string {
  return mode === "test" ? "test_mode_api_key" : "live_mode_api_key";
}

function stripeCliAuthKeyPattern(mode: StripeCliAuthMode): RegExp {
  return mode === "test"
    ? /^(sk|rk)_test_[A-Za-z0-9]+$/
    : /^(sk|rk)_live_[A-Za-z0-9]+$/;
}

function parseStripeCliAuthToml(configToml: string): unknown {
  // eslint-disable-next-line no-restricted-syntax -- sanitize smol-toml parser errors because they include input excerpts that may contain Stripe keys
  try {
    return parse(configToml) as unknown;
  } catch (error) {
    throwIfAbort(error);
    throw new Error("Stripe CLI config is not valid TOML");
  }
}

export function parseStripeCliAuthConfig(
  configToml: string,
  mode: StripeCliAuthMode,
): string {
  const parsed = parseStripeCliAuthToml(configToml);
  if (!isRecord(parsed)) {
    throw new Error("Stripe CLI config is not a TOML table");
  }

  const defaultProfile = parsed.default;
  const profile = isRecord(defaultProfile) ? defaultProfile : parsed;
  const keyField = stripeCliAuthKeyField(mode);
  const apiKey = profile[keyField];
  if (
    typeof apiKey !== "string" ||
    !stripeCliAuthKeyPattern(mode).test(apiKey)
  ) {
    throw new Error(`Stripe CLI config did not contain a ${mode} mode API key`);
  }

  return apiKey;
}

export function redactStripeCliAuthText(value: string): string {
  return redactSandboxMessage(value)
    .replace(/\b(?:rk|sk)_(?:test|live)_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(
      /https:\/\/dashboard\.stripe\.com\/stripecli\/(?:auth|confirm_auth)[^\s'"]*/g,
      "https://dashboard.stripe.com/stripecli/[redacted]",
    );
}
