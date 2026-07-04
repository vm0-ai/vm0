import { command } from "ccstate";
import type {
  ModelProviderListResponse,
  ModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray } from "drizzle-orm";

import { logger } from "../../lib/log";
import { db$, type ReadonlyDb } from "../external/db";
import { notFound } from "../../lib/error";
import { settle } from "../utils";
import { fetchClaudeCodeSubscriptionMetadata } from "./claude-code-usage.service";
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexUsageMetadata,
  type CodexRateLimitResetCreditOutcome,
} from "./codex-usage.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import type {
  SubscriptionUsageMetadata,
  SubscriptionUsageWindowMetadata,
} from "./model-provider-subscription-usage.types";

const L = logger("model-provider-subscription-usage.service");

const CODEX_USAGE_SECRET_NAMES = [
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_ID_TOKEN",
] as const;
const CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";

interface SubscriptionMetadata {
  readonly accountEmail?: string | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
  readonly subscriptionUsage?: SubscriptionUsageMetadata | null;
  readonly subscriptionResetCredits?: number | null;
}

type SerializedSubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;

async function modelProviderSecretValues(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly names: readonly string[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<ReadonlyMap<string, string>> {
  if (args.names.length === 0) {
    return new Map();
  }

  const rows = await args.db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.type, "model-provider"),
        inArray(secrets.name, [...args.names]),
      ),
    );

  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(
      row.name,
      await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      ),
    );
    args.signal.throwIfAborted();
  }
  return values;
}

function serializeUsageWindow(
  window: SubscriptionUsageWindowMetadata | null,
): SerializedSubscriptionUsage["fiveHour"] {
  if (!window) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt?.toISOString() ?? null,
    windowSeconds: window.windowSeconds,
  };
}

function serializeSubscriptionUsage(
  usage: SubscriptionUsageMetadata | null | undefined,
): SerializedSubscriptionUsage | null {
  if (!usage) {
    return null;
  }

  const fiveHour = serializeUsageWindow(usage.fiveHour);
  const weekly = serializeUsageWindow(usage.weekly);
  if (!fiveHour && !weekly) {
    return null;
  }

  return {
    fiveHour,
    weekly,
  };
}

function withSubscriptionMetadata(
  provider: ModelProviderResponse,
  metadata: SubscriptionMetadata | null | undefined,
): ModelProviderResponse {
  if (!metadata) {
    return provider;
  }

  return {
    ...provider,
    accountEmail: metadata.accountEmail ?? provider.accountEmail,
    workspaceName: metadata.workspaceName ?? provider.workspaceName,
    planType: metadata.planType ?? provider.planType,
    subscriptionResetPeriod:
      metadata.subscriptionResetPeriod ?? provider.subscriptionResetPeriod,
    subscriptionNextResetAt:
      metadata.subscriptionNextResetAt?.toISOString() ??
      provider.subscriptionNextResetAt,
    subscriptionUsage: serializeSubscriptionUsage(metadata.subscriptionUsage),
    subscriptionResetCredits:
      metadata.subscriptionResetCredits ?? provider.subscriptionResetCredits,
  };
}

async function refreshCodexProvider(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly provider: ModelProviderResponse;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<ModelProviderResponse> {
  const secretValues = await modelProviderSecretValues({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    names: CODEX_USAGE_SECRET_NAMES,
    featureSwitchContext: args.featureSwitchContext,
    signal: args.signal,
  });
  const accessToken = secretValues.get("CHATGPT_ACCESS_TOKEN");
  const accountId = secretValues.get("CHATGPT_ACCOUNT_ID");
  const idToken = secretValues.get("CHATGPT_ID_TOKEN");
  if (!accessToken || !accountId) {
    return args.provider;
  }

  const metadata = await fetchCodexUsageMetadata({
    accessToken,
    accountId,
    idToken,
    signal: args.signal,
  });

  return withSubscriptionMetadata(args.provider, metadata);
}

async function refreshClaudeCodeProvider(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly provider: ModelProviderResponse;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<ModelProviderResponse> {
  const secretValues = await modelProviderSecretValues({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    names: [CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME],
    featureSwitchContext: args.featureSwitchContext,
    signal: args.signal,
  });
  const accessToken = secretValues.get(CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME);
  if (!accessToken) {
    return args.provider;
  }

  const metadata = await fetchClaudeCodeSubscriptionMetadata({
    accessToken,
    signal: args.signal,
  });

  return withSubscriptionMetadata(args.provider, metadata);
}

async function refreshProvider(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly provider: ModelProviderResponse;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<ModelProviderResponse> {
  if (args.provider.needsReconnect) {
    return args.provider;
  }

  if (args.provider.type === "codex-oauth-token") {
    return await refreshCodexProvider(args);
  }
  if (args.provider.type === "claude-code-oauth-token") {
    return await refreshClaudeCodeProvider(args);
  }
  return args.provider;
}

export const refreshPersonalModelProviderSubscriptionUsage$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly result: ModelProviderListResponse;
    },
    signal: AbortSignal,
  ): Promise<ModelProviderListResponse> => {
    if (args.result.modelProviders.length === 0) {
      return args.result;
    }

    const database = get(db$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const refreshed = await Promise.all(
      args.result.modelProviders.map(async (provider) => {
        const result = await settle(
          refreshProvider({
            db: database,
            orgId: args.orgId,
            userId: args.userId,
            provider,
            featureSwitchContext,
            signal,
          }),
          signal,
        );
        if (result.ok) {
          return result.value;
        }
        L.warn("failed to refresh personal model provider subscription usage", {
          error: result.error,
          orgId: args.orgId,
          providerType: provider.type,
          userId: args.userId,
        });
        return provider;
      }),
    );
    signal.throwIfAborted();

    return {
      modelProviders: refreshed,
    };
  },
);

type NotFoundResponse = ReturnType<typeof notFound>;

export const consumePersonalCodexRateLimitResetCredit$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: CodexRateLimitResetCreditOutcome;
      }
    | NotFoundResponse
  > => {
    const database = get(db$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const secretValues = await modelProviderSecretValues({
      db: database,
      orgId: args.orgId,
      userId: args.userId,
      names: CODEX_USAGE_SECRET_NAMES,
      featureSwitchContext,
      signal,
    });
    const accessToken = secretValues.get("CHATGPT_ACCESS_TOKEN");
    const accountId = secretValues.get("CHATGPT_ACCOUNT_ID");
    if (!accessToken || !accountId) {
      return notFound("Resource not found");
    }

    return await consumeCodexRateLimitResetCredit({
      accessToken,
      accountId,
      idempotencyKey: args.idempotencyKey,
      signal,
    });
  },
);
