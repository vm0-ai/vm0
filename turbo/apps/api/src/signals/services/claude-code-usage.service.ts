import { z } from "zod";

const CLAUDE_CODE_API_BASE_URL = "https://api.anthropic.com";
const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.161";

const usageWindowSchema = z
  .object({
    resets_at: z.string().nullable().optional(),
    resetsAt: z.string().nullable().optional(),
  })
  .passthrough();

const usageRateLimitsSchema = z
  .object({
    five_hour: usageWindowSchema.nullable().optional(),
    seven_day: usageWindowSchema.nullable().optional(),
  })
  .passthrough();

const usageResponseSchema = usageRateLimitsSchema
  .extend({
    rate_limits: usageRateLimitsSchema.nullable().optional(),
  })
  .passthrough();

const profileResponseSchema = z
  .object({
    account: z
      .object({
        email: z.string().nullable().optional(),
        display_name: z.string().nullable().optional(),
        full_name: z.string().nullable().optional(),
        has_claude_max: z.boolean().nullable().optional(),
        has_claude_pro: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    organization: z
      .object({
        name: z.string().nullable().optional(),
        organization_name: z.string().nullable().optional(),
        organization_type: z.string().nullable().optional(),
        rate_limit_tier: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

type ProfileResponse = z.infer<typeof profileResponseSchema>;
type UsageResponse = z.infer<typeof usageResponseSchema>;
type UsageWindow = z.infer<typeof usageWindowSchema>;

interface ClaudeCodeSubscriptionMetadata {
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizePlanType(value: string): string {
  return value.replace(/^claude_/, "").replaceAll("_", " ");
}

function maxTierSuffix(rateLimitTier: string | null): string | null {
  const match = rateLimitTier?.match(/(\d+x)$/);
  return match?.[1] ?? null;
}

function planTypeFromProfile(profile: ProfileResponse): string | null {
  const organizationType = nonEmptyString(
    profile.organization?.organization_type,
  );
  const rateLimitTier = nonEmptyString(profile.organization?.rate_limit_tier);

  if (organizationType === "claude_max") {
    const tierSuffix = maxTierSuffix(rateLimitTier);
    return tierSuffix ? `max ${tierSuffix}` : "max";
  }
  if (organizationType) {
    return normalizePlanType(organizationType);
  }
  if (profile.account?.has_claude_max) {
    const tierSuffix = maxTierSuffix(rateLimitTier);
    return tierSuffix ? `max ${tierSuffix}` : "max";
  }
  if (profile.account?.has_claude_pro) {
    return "pro";
  }
  return null;
}

function accountNameFromProfile(profile: ProfileResponse): string | null {
  return (
    nonEmptyString(profile.account?.email) ??
    nonEmptyString(profile.account?.display_name) ??
    nonEmptyString(profile.account?.full_name) ??
    nonEmptyString(profile.organization?.name) ??
    nonEmptyString(profile.organization?.organization_name)
  );
}

function nextResetAt(value: string | null | undefined): Date | null {
  const text = nonEmptyString(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nextResetAtFromWindow(
  window: UsageWindow | null | undefined,
): Date | null {
  return nextResetAt(window?.resets_at ?? window?.resetsAt);
}

function resetMetadataFromUsage(
  usage: UsageResponse,
): Pick<
  ClaudeCodeSubscriptionMetadata,
  "subscriptionResetPeriod" | "subscriptionNextResetAt"
> {
  const rateLimits = usage.rate_limits;
  const weeklyResetAt =
    nextResetAtFromWindow(rateLimits?.seven_day) ??
    nextResetAtFromWindow(usage.seven_day);
  if (weeklyResetAt) {
    return {
      subscriptionResetPeriod: "weekly",
      subscriptionNextResetAt: weeklyResetAt,
    };
  }

  const fiveHourResetAt =
    nextResetAtFromWindow(rateLimits?.five_hour) ??
    nextResetAtFromWindow(usage.five_hour);
  if (fiveHourResetAt) {
    return {
      subscriptionResetPeriod: "5-hour window",
      subscriptionNextResetAt: fiveHourResetAt,
    };
  }

  return {};
}

async function fetchClaudeCodeJson(args: {
  readonly accessToken: string;
  readonly path: string;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(`${CLAUDE_CODE_API_BASE_URL}${args.path}`, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${args.accessToken}`,
      "anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
      "content-type": "application/json",
      "user-agent": CLAUDE_CODE_USER_AGENT,
    },
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(
      `Claude Code metadata request failed with status ${response.status}`,
    );
  }

  return await response.json();
}

async function fetchProfileMetadata(args: {
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<
  Pick<ClaudeCodeSubscriptionMetadata, "workspaceName" | "planType">
> {
  const parsed = profileResponseSchema.safeParse(
    await fetchClaudeCodeJson({
      accessToken: args.accessToken,
      path: "/api/oauth/profile",
      signal: args.signal,
    }),
  );
  if (!parsed.success) {
    throw new Error("Claude Code profile response shape unrecognized");
  }
  return {
    workspaceName: accountNameFromProfile(parsed.data),
    planType: planTypeFromProfile(parsed.data),
  };
}

async function fetchUsageMetadata(args: {
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<
  Pick<
    ClaudeCodeSubscriptionMetadata,
    "subscriptionResetPeriod" | "subscriptionNextResetAt"
  >
> {
  const parsed = usageResponseSchema.safeParse(
    await fetchClaudeCodeJson({
      accessToken: args.accessToken,
      path: "/api/oauth/usage",
      signal: args.signal,
    }),
  );
  if (!parsed.success) {
    throw new Error("Claude Code usage response shape unrecognized");
  }
  return resetMetadataFromUsage(parsed.data);
}

function hasMetadata(metadata: ClaudeCodeSubscriptionMetadata): boolean {
  return Object.values(metadata).some((value) => {
    return value !== undefined;
  });
}

export async function fetchClaudeCodeSubscriptionMetadata(args: {
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<ClaudeCodeSubscriptionMetadata | undefined> {
  const [profile, usage] = await Promise.allSettled([
    fetchProfileMetadata(args),
    fetchUsageMetadata(args),
  ]);
  args.signal.throwIfAborted();

  const metadata: ClaudeCodeSubscriptionMetadata = {
    ...(profile.status === "fulfilled" ? profile.value : {}),
    ...(usage.status === "fulfilled" ? usage.value : {}),
  };

  return hasMetadata(metadata) ? metadata : undefined;
}
