import {
  SOCIAL_TRANSCRIPT_MAX_LANGUAGE_CHARS,
  SOCIAL_TRANSCRIPT_MAX_SEGMENTS,
  SOCIAL_TRANSCRIPT_MAX_TEXT_CHARS,
  SOCIAL_TRANSCRIPT_MAX_TIMESTAMP_CHARS,
  type SocialTranscriptRequest,
  type SocialTranscriptResponse,
  type SocialTranscriptResult,
} from "@okouai/api-contracts/contracts/social";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "socialkit";
const USAGE_KIND = "social";
const BILLING_CATEGORY = "youtube.transcript";
const SOCIALKIT_TRANSCRIPT_URL = "https://api.socialkit.dev/youtube/transcript";
const SOCIALKIT_TIMEOUT_MS = 240_000;
const MAX_SOCIALKIT_RESPONSE_BYTES = 4 * 1024 * 1024;
const L = logger("SocialTranscript");

type ProviderFailureKind =
  | "http_error"
  | "invalid_response"
  | "network"
  | "response_too_large"
  | "timeout";

const socialKitSegmentSchema = z.object({
  text: z.string().max(SOCIAL_TRANSCRIPT_MAX_TEXT_CHARS),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  timestamp: z
    .string()
    .max(SOCIAL_TRANSCRIPT_MAX_TIMESTAMP_CHARS)
    .nullable()
    .optional(),
});

const socialKitResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    transcript: z.string().min(1).max(SOCIAL_TRANSCRIPT_MAX_TEXT_CHARS),
    transcriptSegments: z
      .array(socialKitSegmentSchema)
      .max(SOCIAL_TRANSCRIPT_MAX_SEGMENTS),
    wordCount: z.number().int().nonnegative(),
    language: z
      .string()
      .max(SOCIAL_TRANSCRIPT_MAX_LANGUAGE_CHARS)
      .nullable()
      .optional(),
  }),
});

type ErrorStatus = 400 | 404 | 502 | 503;

interface SocialTranscriptErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface SocialTranscriptErrorResult {
  readonly kind: "error";
  readonly error: SocialTranscriptErrorResponse;
}

type SocialKitBodyResult =
  | SocialTranscriptErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type SocialKitResponseResult =
  | SocialTranscriptErrorResult
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly body: unknown;
    };

interface AuthedSocialTranscriptArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: SocialTranscriptRequest;
}

interface CompleteSocialTranscriptArgs {
  readonly accessKey: string;
  readonly request: SocialTranscriptRequest;
  readonly recordUsage: () => Promise<number>;
}

type SocialTranscriptCommandResponse =
  | { readonly status: 200; readonly body: SocialTranscriptResponse }
  | SocialTranscriptErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function errorResponse(
  status: ErrorStatus,
  message: string,
  code: string,
): SocialTranscriptErrorResponse {
  return { status, body: errorBody(message, code) };
}

function badGateway(
  message: string,
  code: string,
): SocialTranscriptErrorResponse {
  return errorResponse(502, message, code);
}

function errorResult(
  error: SocialTranscriptErrorResponse,
): SocialTranscriptErrorResult {
  return { kind: "error", error };
}

function invalidResponse(): SocialTranscriptErrorResponse {
  return badGateway(
    "SocialKit returned an invalid YouTube transcript response",
    "SOCIALKIT_INVALID_RESPONSE",
  );
}

function logProviderFailure(
  failureKind: ProviderFailureKind,
  httpStatus?: number,
): void {
  L.warn("SocialKit transcript request failed", {
    operation: BILLING_CATEGORY,
    failureKind,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

function providerHttpError(status: number): SocialTranscriptErrorResponse {
  switch (status) {
    case 400: {
      return errorResponse(
        400,
        "SocialKit rejected the YouTube content URL",
        "SOCIALKIT_INVALID_CONTENT",
      );
    }
    case 401: {
      return badGateway(
        "SocialKit provider authentication failed",
        "SOCIALKIT_AUTH_ERROR",
      );
    }
    case 403: {
      return errorResponse(
        503,
        "SocialKit provider quota is exhausted",
        "SOCIALKIT_QUOTA_EXHAUSTED",
      );
    }
    case 404: {
      return errorResponse(
        404,
        "The YouTube transcript is unavailable",
        "SOCIALKIT_CONTENT_UNAVAILABLE",
      );
    }
    case 429: {
      return badGateway(
        "SocialKit is temporarily rate limited",
        "SOCIALKIT_RATE_LIMITED",
      );
    }
    default: {
      return badGateway(
        "SocialKit YouTube transcript request failed",
        "SOCIALKIT_UPSTREAM_ERROR",
      );
    }
  }
}

function sanitizeProviderText(value: string): string {
  return Array.from(value, (character) => {
    const codeUnit = character.charCodeAt(0);
    const isUnsafeControl =
      (codeUnit <= 0x1f &&
        character !== "\n" &&
        character !== "\r" &&
        character !== "\t") ||
      (codeUnit >= 0x7f && codeUnit <= 0x9f);
    return isUnsafeControl ? " " : character;
  }).join("");
}

function normalizedOptionalText(
  value: string | null | undefined,
): string | undefined {
  const normalized = value ? sanitizeProviderText(value).trim() : "";
  return normalized || undefined;
}

function normalizeSocialKitResponse(
  body: unknown,
): SocialTranscriptResult | SocialTranscriptErrorResponse {
  const parsed = socialKitResponseSchema.safeParse(body);
  if (!parsed.success) {
    return invalidResponse();
  }
  const transcript = sanitizeProviderText(parsed.data.data.transcript).trim();
  if (!transcript) {
    return invalidResponse();
  }
  const language = normalizedOptionalText(parsed.data.data.language);
  return {
    transcript,
    transcriptSegments: parsed.data.data.transcriptSegments.map((segment) => {
      const timestamp = normalizedOptionalText(segment.timestamp);
      return {
        text: sanitizeProviderText(segment.text),
        start: segment.start,
        duration: segment.duration,
        ...(timestamp ? { timestamp } : {}),
      };
    }),
    wordCount: parsed.data.data.wordCount,
    ...(language ? { language } : {}),
  };
}

function isErrorResponse(
  value: unknown,
): value is SocialTranscriptErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

async function fetchSocialKitTranscript(
  accessKey: string,
  request: SocialTranscriptRequest,
  signal: AbortSignal,
): Promise<SocialKitBodyResult> {
  const settled = await settle(
    (async (): Promise<SocialKitResponseResult> => {
      const url = new URL(SOCIALKIT_TRANSCRIPT_URL);
      url.searchParams.set("url", request.url);
      const response = await fetch(url, {
        headers: { "x-access-key": accessKey },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(SOCIALKIT_TIMEOUT_MS),
        ]),
      });
      const textResult = await readBoundedResponseText(
        response,
        MAX_SOCIALKIT_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        logProviderFailure("response_too_large", response.status);
        return errorResult(
          badGateway(
            "SocialKit YouTube transcript response is too large",
            "SOCIAL_TRANSCRIPT_OUTPUT_TOO_LARGE",
          ),
        );
      }
      return {
        kind: "response",
        response,
        body: textResult.text ? safeJsonParse(textResult.text) : null,
      };
    })(),
  );

  if (!settled.ok) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    const { error } = settled;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      logProviderFailure("timeout");
      return errorResult(
        badGateway(
          "SocialKit YouTube transcript request timed out",
          "SOCIAL_TRANSCRIPT_TIMEOUT",
        ),
      );
    }
    logProviderFailure("network");
    return errorResult(
      badGateway(
        "SocialKit YouTube transcript request failed",
        "SOCIALKIT_UPSTREAM_ERROR",
      ),
    );
  }
  if (settled.value.kind === "error") {
    return settled.value;
  }
  if (!settled.value.response.ok) {
    logProviderFailure("http_error", settled.value.response.status);
    return errorResult(providerHttpError(settled.value.response.status));
  }
  return { kind: "body", body: settled.value.body };
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

async function completeSocialTranscript(
  args: CompleteSocialTranscriptArgs,
  providerSignal: AbortSignal,
): Promise<SocialTranscriptCommandResponse> {
  const providerResult = await fetchSocialKitTranscript(
    args.accessKey,
    args.request,
    providerSignal,
  );
  if (providerResult.kind === "error") {
    return providerResult.error;
  }
  const result = normalizeSocialKitResponse(providerResult.body);
  if (isErrorResponse(result)) {
    logProviderFailure("invalid_response");
    return result;
  }
  const creditsCharged = await args.recordUsage();
  return {
    status: 200,
    body: {
      requestedUrl: args.request.url,
      platform: "youtube",
      provider: PROVIDER,
      billingCategory: BILLING_CATEGORY,
      billingQuantity: 1,
      creditsCharged,
      result,
    },
  };
}

export const socialTranscript$ = command(
  async (
    { get, set },
    args: AuthedSocialTranscriptArgs,
    signal: AbortSignal,
  ): Promise<SocialTranscriptCommandResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_ACCESS_KEY");
    if (!accessKey) {
      return errorResponse(
        503,
        "Okou SocialKit provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: BILLING_CATEGORY,
        },
        label: "Okou Social Transcript",
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const runId = runIdForUsage(args.auth);
    return completeSocialTranscript(
      {
        accessKey,
        request: args.body,
        recordUsage: () => {
          return set(
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
                category: BILLING_CATEGORY,
              },
              label: "social transcript",
            },
            signal,
          );
        },
      },
      requestSignal,
    );
  },
);
