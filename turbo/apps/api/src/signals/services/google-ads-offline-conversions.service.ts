import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";

const L = logger("GoogleAdsOfflineConversions");

const GOOGLE_ADS_API_VERSION = "v24";
const GOOGLE_ADS_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_API_BASE_URL = "https://googleads.googleapis.com";
const FREE_TRIAL_VALUE_USD = 20;
const PAID_SUBSCRIBER_VALUE_USD = {
  pro: 20,
  team: 200,
} as const;

type GoogleAdsOfflineConversionKind = "free_trial" | "paid_subscriber";
type GoogleAdsOfflineConversionTier = keyof typeof PAID_SUBSCRIBER_VALUE_USD;

interface GoogleAdsOfflineConversionConfig {
  readonly customerId: string;
  readonly loginCustomerId?: string;
  readonly developerToken: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly conversionAction: string;
}

interface UploadGoogleAdsOfflineConversionArgs {
  readonly kind: GoogleAdsOfflineConversionKind;
  readonly tier: GoogleAdsOfflineConversionTier;
  readonly transactionId: string;
  readonly conversionTime: Date;
  readonly metadata: Readonly<Record<string, string>> | null | undefined;
}

interface OAuthTokenResponse {
  readonly access_token?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstConfiguredEnv(...names: readonly string[]): string | null {
  for (const name of names) {
    const value = optionalEnv(name);
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeGoogleAdsCustomerId(value: string): string {
  return value.replaceAll("-", "").trim();
}

function conversionActionForKind(
  kind: GoogleAdsOfflineConversionKind,
): string | null {
  if (kind === "free_trial") {
    return firstConfiguredEnv("GOOGLE_ADS_FREE_TRIAL_CONVERSION_ACTION_ID");
  }
  return firstConfiguredEnv("GOOGLE_ADS_PAID_SUBSCRIBER_CONVERSION_ACTION_ID");
}

function googleAdsOfflineConversionConfig(
  kind: GoogleAdsOfflineConversionKind,
): GoogleAdsOfflineConversionConfig | null {
  const customerId = firstConfiguredEnv("GOOGLE_ADS_OFFLINE_CUSTOMER_ID");
  const developerToken = firstConfiguredEnv(
    "GOOGLE_ADS_OFFLINE_DEVELOPER_TOKEN",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
  );
  const clientId = firstConfiguredEnv(
    "GOOGLE_ADS_OFFLINE_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_ID",
  );
  const clientSecret = firstConfiguredEnv(
    "GOOGLE_ADS_OFFLINE_CLIENT_SECRET",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  );
  const refreshToken = firstConfiguredEnv("GOOGLE_ADS_OFFLINE_REFRESH_TOKEN");
  const conversionAction = conversionActionForKind(kind);

  if (
    !customerId ||
    !developerToken ||
    !clientId ||
    !clientSecret ||
    !refreshToken ||
    !conversionAction
  ) {
    return null;
  }

  const loginCustomerId = firstConfiguredEnv(
    "GOOGLE_ADS_OFFLINE_LOGIN_CUSTOMER_ID",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  );
  return {
    customerId: normalizeGoogleAdsCustomerId(customerId),
    ...(loginCustomerId
      ? { loginCustomerId: normalizeGoogleAdsCustomerId(loginCustomerId) }
      : {}),
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    conversionAction,
  };
}

function conversionActionResourceName(args: {
  readonly customerId: string;
  readonly conversionAction: string;
}): string {
  if (args.conversionAction.startsWith("customers/")) {
    return args.conversionAction;
  }
  return `customers/${args.customerId}/conversionActions/${args.conversionAction}`;
}

function clickIdentifier(
  metadata: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> | null {
  if (!metadata) {
    return null;
  }
  if (metadata.gclid) {
    return { gclid: metadata.gclid };
  }
  if (metadata.gbraid) {
    return { gbraid: metadata.gbraid };
  }
  if (metadata.wbraid) {
    return { wbraid: metadata.wbraid };
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatGoogleAdsConversionDateTime(date: Date): string {
  return [
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
      date.getUTCDate(),
    )}`,
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
      date.getUTCSeconds(),
    )}+00:00`,
  ].join(" ");
}

function conversionValue(args: {
  readonly kind: GoogleAdsOfflineConversionKind;
  readonly tier: GoogleAdsOfflineConversionTier;
}): number {
  return args.kind === "free_trial"
    ? FREE_TRIAL_VALUE_USD
    : PAID_SUBSCRIBER_VALUE_USD[args.tier];
}

async function readJsonRecord(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await response.json().catch(() => null);
  return isRecord(parsed) ? parsed : null;
}

async function googleAdsAccessToken(
  config: GoogleAdsOfflineConversionConfig,
): Promise<string | null> {
  const response = await fetch(GOOGLE_ADS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await readJsonRecord(response)) as OAuthTokenResponse | null;

  if (!response.ok) {
    L.warn("Google Ads OAuth refresh failed", {
      status: response.status,
      error: body?.error ?? null,
      errorDescription: body?.error_description ?? null,
    });
    return null;
  }

  return typeof body?.access_token === "string" ? body.access_token : null;
}

export async function uploadGoogleAdsOfflineConversion(
  args: UploadGoogleAdsOfflineConversionArgs,
): Promise<void> {
  const config = googleAdsOfflineConversionConfig(args.kind);
  if (!config) {
    return;
  }

  const identifier = clickIdentifier(args.metadata);
  if (!identifier) {
    return;
  }

  try {
    const accessToken = await googleAdsAccessToken(config);
    if (!accessToken) {
      return;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": config.developerToken,
    };
    if (config.loginCustomerId) {
      headers["login-customer-id"] = config.loginCustomerId;
    }

    const response = await fetch(
      `${GOOGLE_ADS_API_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${encodeURIComponent(
        config.customerId,
      )}:uploadClickConversions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          conversions: [
            {
              ...identifier,
              conversionAction: conversionActionResourceName(config),
              conversionDateTime: formatGoogleAdsConversionDateTime(
                args.conversionTime,
              ),
              conversionValue: conversionValue({
                kind: args.kind,
                tier: args.tier,
              }),
              currencyCode: "USD",
              orderId: args.transactionId,
              conversionEnvironment: "WEB",
            },
          ],
          partialFailure: true,
        }),
      },
    );
    const body = await readJsonRecord(response);

    if (!response.ok) {
      L.warn("Google Ads offline conversion upload failed", {
        status: response.status,
        kind: args.kind,
        transactionId: args.transactionId,
        response: body,
      });
      return;
    }

    if (isRecord(body?.partialFailureError)) {
      L.warn("Google Ads offline conversion upload had partial failures", {
        kind: args.kind,
        transactionId: args.transactionId,
        partialFailureError: body.partialFailureError,
      });
      return;
    }

    L.debug("Google Ads offline conversion uploaded", {
      kind: args.kind,
      transactionId: args.transactionId,
      jobId: body?.jobId ?? null,
    });
  } catch (error) {
    L.warn("Google Ads offline conversion upload errored", {
      kind: args.kind,
      transactionId: args.transactionId,
      error,
    });
  }
}
