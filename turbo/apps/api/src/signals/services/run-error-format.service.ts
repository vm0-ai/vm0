import { command, computed, type Computed } from "ccstate";
import {
  formatRunErrorForExternalSurface,
  isClaudeCodeAuthenticationCredentialsError,
} from "@vm0/api-contracts/contracts/errors";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";

const INSUFFICIENT_CREDITS_MARKER = "insufficient_credits";
const PRO_REQUIRED_MARKER = "pro_required";

interface RunErrorProviderContext {
  readonly userId: string;
  readonly orgId: string;
  readonly modelProviderType: ModelProviderType | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

interface FormatRunErrorLikeWebMessageParams {
  readonly chatThreadId?: string | null;
  readonly runId: string;
  readonly errorMessage: string;
  readonly modelProviderType?: ModelProviderType | null;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope | null;
  readonly selectedModel?: string | null;
  readonly canManageOrgModelProviders?: boolean;
}

function buildModelProvidersUrl(): string {
  const appUrl = env("APP_URL").replace(/\/$/u, "");
  return `${appUrl}/?settings=model`;
}

function buildPersonalModelProvidersUrl(): string {
  const appUrl = env("APP_URL").replace(/\/$/u, "");
  return `${appUrl}/?settings=model`;
}

function buildClaudeCodeCredentialRecoveryUrl(params: {
  readonly modelProviderType: ModelProviderType | null | undefined;
  readonly modelProviderCredentialScope:
    | ModelProviderCredentialScope
    | null
    | undefined;
}): string {
  if (
    params.modelProviderType === "claude-code-oauth-token" &&
    params.modelProviderCredentialScope === "member"
  ) {
    return buildPersonalModelProvidersUrl();
  }
  return buildModelProvidersUrl();
}

function isProRequiredRunError(message: string): boolean {
  return message.toLowerCase().includes(PRO_REQUIRED_MARKER);
}

function isInsufficientCreditsRunError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("insufficient_credits") ||
    normalized.includes("insufficient credits")
  );
}

function formatLatestSessionProviderType(
  value: string | null,
): ModelProviderType | null {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function formatRunModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderCredentialScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function runErrorProviderContext(
  runId: string,
): Computed<Promise<RunErrorProviderContext | undefined>> {
  return computed(async (get): Promise<RunErrorProviderContext | undefined> => {
    const [run] = await get(db$)
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        modelProviderType: zeroRuns.modelProvider,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return undefined;
    }

    return {
      userId: run.userId,
      orgId: run.orgId,
      modelProviderType: formatLatestSessionProviderType(run.modelProviderType),
      modelProviderCredentialScope: formatRunModelProviderCredentialScope(
        run.modelProviderCredentialScope,
      ),
      selectedModel: run.selectedModel,
    };
  });
}

function formatRunErrorLikeWebMessage(
  params: FormatRunErrorLikeWebMessageParams,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const errorMessage = params.errorMessage.trim() || "Run failed";
    if (isProRequiredRunError(errorMessage)) {
      return PRO_REQUIRED_MARKER;
    }
    if (isInsufficientCreditsRunError(errorMessage)) {
      return INSUFFICIENT_CREDITS_MARKER;
    }

    const providerContext =
      params.modelProviderType !== undefined &&
      params.modelProviderCredentialScope !== undefined &&
      params.selectedModel !== undefined
        ? undefined
        : await get(runErrorProviderContext(params.runId));
    const modelProviderType =
      params.modelProviderType !== undefined
        ? params.modelProviderType
        : providerContext?.modelProviderType;
    const modelProviderCredentialScope =
      params.modelProviderCredentialScope !== undefined
        ? params.modelProviderCredentialScope
        : providerContext?.modelProviderCredentialScope;
    const selectedModel =
      params.selectedModel !== undefined
        ? params.selectedModel
        : providerContext?.selectedModel;
    return formatRunErrorForExternalSurface({
      code: "INTERNAL_SERVER_ERROR",
      message: errorMessage,
      selectedModel,
      claudeCodeCredentialRecovery: {
        modelProviderType,
        modelProviderCredentialScope,
        canManageOrgModelProviders: params.canManageOrgModelProviders ?? false,
        modelProvidersUrl: buildClaudeCodeCredentialRecoveryUrl({
          modelProviderType,
          modelProviderCredentialScope,
        }),
      },
    });
  });
}

export const formatRunErrorForRunOwner$ = command(
  async (
    { get, set },
    params: Omit<
      FormatRunErrorLikeWebMessageParams,
      "modelProviderType" | "modelProviderCredentialScope"
    >,
    signal: AbortSignal,
  ): Promise<string> => {
    const providerContext = await get(runErrorProviderContext(params.runId));
    signal.throwIfAborted();

    let canManageOrgModelProviders = params.canManageOrgModelProviders ?? false;
    if (
      params.canManageOrgModelProviders === undefined &&
      providerContext?.modelProviderType === "anthropic-api-key" &&
      providerContext.modelProviderCredentialScope === "org" &&
      isClaudeCodeAuthenticationCredentialsError(params.errorMessage)
    ) {
      const membership = await set(
        getMemberRoleAndUpdateCache$,
        providerContext.orgId,
        providerContext.userId,
        signal,
      );
      signal.throwIfAborted();
      canManageOrgModelProviders = membership?.role === "admin";
    }

    return await get(
      formatRunErrorLikeWebMessage({
        ...params,
        modelProviderType: providerContext?.modelProviderType ?? null,
        modelProviderCredentialScope:
          providerContext?.modelProviderCredentialScope ?? null,
        selectedModel: providerContext?.selectedModel ?? null,
        canManageOrgModelProviders,
      }),
    );
  },
);
