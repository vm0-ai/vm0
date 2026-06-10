import { delay } from "signal-timers";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { safeJsonParse, settle } from "../utils";

const L = logger("GoogleAdsOfflineConversions");

const GOOGLE_ADS_API_VERSION = "v24";
const GOOGLE_ADS_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_API_BASE_URL = "https://googleads.googleapis.com";
const GOOGLE_ADS_REQUEST_MAX_ATTEMPTS = 3;
const GOOGLE_ADS_REQUEST_RETRY_DELAY_MS = 100;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
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
  readonly conversionValueUsd?: number;
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
  readonly conversionValueUsd: number | undefined;
}): number {
  if (args.conversionValueUsd !== undefined) {
    return args.conversionValueUsd;
  }
  return args.kind === "free_trial"
    ? FREE_TRIAL_VALUE_USD
    : PAID_SUBSCRIBER_VALUE_USD[args.tier];
}

async function readJsonRecord(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const text = await settle(response.text());
  if (!text.ok) {
    return null;
  }
  const parsed = safeJsonParse(text.value);
  return isRecord(parsed) ? parsed : null;
}

function shouldRetryGoogleAdsResponse(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

function retryDelay(attempt: number): Promise<void> {
  return delay(GOOGLE_ADS_REQUEST_RETRY_DELAY_MS * attempt, {
    signal: NEVER_ABORTED_SIGNAL,
  });
}

async function fetchGoogleAdsJson(
  input: string,
  init: RequestInit,
  context: Readonly<Record<string, string>>,
): Promise<{
  readonly response: Response;
  readonly body: Record<string, unknown> | null;
}> {
  for (let attempt = 1; attempt <= GOOGLE_ADS_REQUEST_MAX_ATTEMPTS; attempt++) {
    const fetchResult = await settle(fetch(input, init));
    if (!fetchResult.ok) {
      if (attempt === GOOGLE_ADS_REQUEST_MAX_ATTEMPTS) {
        throw new Error("Google Ads request failed", {
          cause: fetchResult.error,
        });
      }
      L.warn("Google Ads request errored transiently; retrying", {
        ...context,
        attempt: String(attempt),
        error: fetchResult.error,
      });
      await retryDelay(attempt);
      continue;
    }

    const response = fetchResult.value;
    const body = await readJsonRecord(response);
    if (
      !shouldRetryGoogleAdsResponse(response) ||
      attempt === GOOGLE_ADS_REQUEST_MAX_ATTEMPTS
    ) {
      return { response, body };
    }
    L.warn("Google Ads request failed transiently; retrying", {
      ...context,
      attempt: String(attempt),
      status: String(response.status),
    });
    await retryDelay(attempt);
  }

  throw new Error("Google Ads request retry loop exited unexpectedly");
}

async function googleAdsAccessToken(
  config: GoogleAdsOfflineConversionConfig,
): Promise<string | null> {
  const { response, body } = await fetchGoogleAdsJson(
    GOOGLE_ADS_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    },
    { phase: "oauth" },
  );
  const tokenBody = body as OAuthTokenResponse | null;

  if (!response.ok) {
    L.warn("Google Ads OAuth refresh failed", {
      status: response.status,
      error: tokenBody?.error ?? null,
      errorDescription: tokenBody?.error_description ?? null,
    });
    return null;
  }

  return typeof tokenBody?.access_token === "string"
    ? tokenBody.access_token
    : null;
}

async function uploadGoogleAdsOfflineConversionWithConfig(args: {
  readonly upload: UploadGoogleAdsOfflineConversionArgs;
  readonly config: GoogleAdsOfflineConversionConfig;
  readonly identifier: Readonly<Record<string, string>>;
}): Promise<void> {
  const accessToken = await googleAdsAccessToken(args.config);
  if (!accessToken) {
    return;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "developer-token": args.config.developerToken,
  };
  if (args.config.loginCustomerId) {
    headers["login-customer-id"] = args.config.loginCustomerId;
  }

  const value = conversionValue({
    kind: args.upload.kind,
    tier: args.upload.tier,
    conversionValueUsd: args.upload.conversionValueUsd,
  });
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }

  const { response, body } = await fetchGoogleAdsJson(
    `${GOOGLE_ADS_API_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${encodeURIComponent(
      args.config.customerId,
    )}:uploadClickConversions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        conversions: [
          {
            ...args.identifier,
            conversionAction: conversionActionResourceName(args.config),
            conversionDateTime: formatGoogleAdsConversionDateTime(
              args.upload.conversionTime,
            ),
            conversionValue: value,
            currencyCode: "USD",
            orderId: args.upload.transactionId,
            conversionEnvironment: "WEB",
          },
        ],
        partialFailure: true,
      }),
    },
    {
      phase: "upload",
      kind: args.upload.kind,
      transactionId: args.upload.transactionId,
    },
  );

  if (!response.ok) {
    L.warn("Google Ads offline conversion upload failed", {
      status: response.status,
      kind: args.upload.kind,
      transactionId: args.upload.transactionId,
      response: body,
    });
    return;
  }

  if (isRecord(body?.partialFailureError)) {
    L.warn("Google Ads offline conversion upload had partial failures", {
      kind: args.upload.kind,
      transactionId: args.upload.transactionId,
      partialFailureError: body.partialFailureError,
    });
    return;
  }

  L.debug("Google Ads offline conversion uploaded", {
    kind: args.upload.kind,
    transactionId: args.upload.transactionId,
    jobId: body?.jobId ?? null,
  });
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

  const result = await settle(
    uploadGoogleAdsOfflineConversionWithConfig({
      upload: args,
      config,
      identifier,
    }),
  );
  if (!result.ok) {
    L.warn("Google Ads offline conversion upload errored", {
      kind: args.kind,
      transactionId: args.transactionId,
      error: result.error,
    });
  }
}
