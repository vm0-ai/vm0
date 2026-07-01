import { z } from "zod";

import { now } from "../../lib/time";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const MINUTE_SECONDS = 60;

const rateLimitWindowSchema = z
  .object({
    limit_window_seconds: z.number().nullable().optional(),
    reset_after_seconds: z.number().nullable().optional(),
    reset_at: z.number().nullable().optional(),
  })
  .passthrough();

const rateLimitDetailsSchema = z
  .object({
    primary_window: rateLimitWindowSchema.nullable().optional(),
    secondary_window: rateLimitWindowSchema.nullable().optional(),
  })
  .passthrough();

const codexUsageResponseSchema = z
  .object({
    plan_type: z.string().nullable().optional(),
    rate_limit: rateLimitDetailsSchema.nullable().optional(),
  })
  .passthrough();

type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

interface CodexUsageMetadata {
  readonly planType: string | null;
  readonly subscriptionResetPeriod: string | null;
  readonly subscriptionNextResetAt: Date | null;
}

interface UsageResetWindow {
  readonly period: string | null;
  readonly nextResetAt: Date | null;
  readonly limitWindowSeconds: number | null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function periodLabel(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }
  if (seconds === WEEK_SECONDS) {
    return "weekly";
  }
  if (seconds === DAY_SECONDS) {
    return "daily";
  }
  if (seconds === HOUR_SECONDS) {
    return "hourly";
  }
  if (seconds % WEEK_SECONDS === 0) {
    return `${seconds / WEEK_SECONDS}-week window`;
  }
  if (seconds % DAY_SECONDS === 0) {
    return `${seconds / DAY_SECONDS}-day window`;
  }
  if (seconds % HOUR_SECONDS === 0) {
    return `${seconds / HOUR_SECONDS}-hour window`;
  }
  if (seconds % MINUTE_SECONDS === 0) {
    return `${seconds / MINUTE_SECONDS}-minute window`;
  }
  return `${seconds}-second window`;
}

function dateFromResetWindow(window: RateLimitWindow): Date | null {
  if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
    return new Date(window.reset_at * 1000);
  }
  if (
    typeof window.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds)
  ) {
    return new Date(now() + window.reset_after_seconds * 1000);
  }
  return null;
}

function resetWindowFromUsageWindow(
  window: RateLimitWindow | null | undefined,
): UsageResetWindow | null {
  if (!window) {
    return null;
  }
  const period = periodLabel(window.limit_window_seconds);
  const nextResetAt = dateFromResetWindow(window);
  if (!period && !nextResetAt) {
    return null;
  }
  return {
    period,
    nextResetAt,
    limitWindowSeconds: window.limit_window_seconds ?? null,
  };
}

function chooseSubscriptionResetWindow(
  rateLimit: z.infer<typeof rateLimitDetailsSchema> | null | undefined,
): UsageResetWindow | null {
  if (!rateLimit) {
    return null;
  }

  const windows = [
    resetWindowFromUsageWindow(rateLimit.primary_window),
    resetWindowFromUsageWindow(rateLimit.secondary_window),
  ].filter((window): window is UsageResetWindow => {
    return window !== null;
  });

  windows.sort((left, right) => {
    return (
      (right.limitWindowSeconds ?? 0) - (left.limitWindowSeconds ?? 0) ||
      (left.nextResetAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.nextResetAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    );
  });
  return windows[0] ?? null;
}

export async function fetchCodexUsageMetadata(args: {
  readonly accessToken: string;
  readonly accountId: string;
  readonly signal: AbortSignal;
}): Promise<CodexUsageMetadata | null> {
  const response = await fetch(CHATGPT_USAGE_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "chatgpt-account-id": args.accountId,
      originator: CODEX_ORIGINATOR,
      "user-agent": CODEX_USER_AGENT,
    },
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(
      `Codex usage request failed with status ${response.status}`,
    );
  }

  const parsed = codexUsageResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Codex usage response shape unrecognized");
  }

  const resetWindow = chooseSubscriptionResetWindow(parsed.data.rate_limit);
  return {
    planType: nonEmptyString(parsed.data.plan_type),
    subscriptionResetPeriod: resetWindow?.period ?? null,
    subscriptionNextResetAt: resetWindow?.nextResetAt ?? null,
  };
}
