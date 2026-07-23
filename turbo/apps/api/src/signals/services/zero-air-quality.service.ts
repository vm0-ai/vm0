import {
  ZERO_AIR_QUALITY_ATTRIBUTION,
  type ZeroAirQualityCurrentRequest,
  type ZeroAirQualityResponse,
} from "@vm0/api-contracts/contracts/zero-weather";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { env } from "../../lib/env";
import { safeJsonParse } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./zero-managed-usage.service";

const PROVIDER = "google-air-quality";
const USAGE_KIND = "weather";
const CURRENT_CATEGORY = "current";
const GOOGLE_AIR_QUALITY_CURRENT_URL =
  "https://airquality.googleapis.com/v1/currentConditions:lookup";

type ErrorStatus = 502 | 503;

interface AirQualityErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type ZeroAirQualityCommandResponse =
  | { readonly status: 200; readonly body: ZeroAirQualityResponse }
  | AirQualityErrorResponse
  | ManagedUsageErrorResponse;

interface AuthedAirQualityArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: ZeroAirQualityCurrentRequest;
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(message: string): AirQualityErrorResponse {
  return {
    status: 502,
    body: errorBody(message, "GOOGLE_AIR_QUALITY_ERROR"),
  };
}

function serviceUnavailable(
  message: string,
  code: string,
): AirQualityErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function googleAirQualityErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return "Google Air Quality request failed";
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

export const zeroAirQualityCurrent$ = command(
  async (
    { set },
    args: AuthedAirQualityArgs,
    signal: AbortSignal,
  ): Promise<ZeroAirQualityCommandResponse> => {
    const apiKey = env("ZERO_WEATHER_GOOGLE_WEATHER_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Weather Google Air Quality provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: CURRENT_CATEGORY,
        },
        label: "Zero Weather",
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const url = new URL(GOOGLE_AIR_QUALITY_CURRENT_URL);
    url.searchParams.set("key", apiKey);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: {
          latitude: args.body.lat,
          longitude: args.body.lng,
        },
        universalAqi: true,
        extraComputations: ["LOCAL_AQI", "POLLUTANT_CONCENTRATION"],
        ...(args.body.languageCode
          ? { languageCode: args.body.languageCode }
          : {}),
      }),
      signal,
    });
    const result = await readResponseBody(response);
    signal.throwIfAborted();
    if (!response.ok) {
      return badGateway(googleAirQualityErrorMessage(result));
    }

    const runId = runIdForUsage(args.auth);
    const creditsCharged = await set(
      recordManagedUsage$,
      {
        actor: {
          orgId: args.auth.orgId,
          userId: args.auth.userId,
          ...(runId ? { runId } : {}),
        },
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: CURRENT_CATEGORY,
        },
        label: "weather",
      },
      signal,
    );

    return {
      status: 200,
      body: {
        operation: "air-quality.current",
        provider: PROVIDER,
        attribution: ZERO_AIR_QUALITY_ATTRIBUTION,
        creditsCharged,
        billingCategory: CURRENT_CATEGORY,
        billingQuantity: 1,
        result,
      },
    };
  },
);
